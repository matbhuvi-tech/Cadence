import React, { useState, useEffect } from 'react';
import { X, Play, Plus, ListPlus, Disc3, Clock, AlertTriangle } from 'lucide-react';
import type { DbRelease, DbTrack, AlbumVersionSummary } from '../../types/remote';
import { fetchTracks, getArtworkUrl } from '../../services/api';

interface AlbumModalProps {
  release: DbRelease | null;
  token: string;
  onClose: () => void;
  onPlayRelease: (releaseId: string) => void;
  onQueueRelease: (releaseId: string, playNext?: boolean) => void;
  onPlayTrack: (filePath: string) => void;
  onQueueTrack: (filePath: string, playNext?: boolean) => void;
  onTriggerToast?: (message: string, onUndo?: () => void) => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatVersionLabel(version: AlbumVersionSummary): string {
  const parts: string[] = [];
  if (version.releaseYear) parts.push(String(version.releaseYear));
  if (version.formatSummary) parts.push(version.formatSummary);
  if (version.avgDrScore) parts.push(`DR${version.avgDrScore}`);
  return parts.length > 0 ? parts.join(' • ') : version.title;
}

export const AlbumModal: React.FC<AlbumModalProps> = ({
  release,
  token,
  onClose,
  onPlayRelease,
  onQueueRelease,
  onPlayTrack,
  onQueueTrack,
  onTriggerToast,
}) => {
  const [activeReleaseId, setActiveReleaseId] = useState<string>(release?.id || '');
  const [tracks, setTracks] = useState<DbTrack[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const versions = release?.versions || [];

  // Determine active release id upon initial mount or release change
  useEffect(() => {
    if (!release) return;
    const defaultVer = versions.find((v) => v.isDefault);
    setActiveReleaseId(defaultVer ? defaultVer.releaseId : release.id);
  }, [release]);

  // Fetch tracks whenever activeReleaseId changes
  useEffect(() => {
    if (!activeReleaseId) return;
    setLoading(true);
    setError(null);
    fetchTracks(token, activeReleaseId)
      .then((data) => {
        setTracks(data);
        setLoading(false);
      })
      .catch((err) => {
        setError('Failed to load tracklist.');
        setLoading(false);
        console.error(err);
      });
  }, [activeReleaseId, token]);

  if (!release) return null;

  const activeVersion = versions.find((v) => v.releaseId === activeReleaseId);
  const isSelectedOffline = activeVersion ? !activeVersion.isOnline : false;
  const artworkUrl = getArtworkUrl(activeReleaseId || release.id, token);

  const handlePlayAlbum = () => {
    if (isSelectedOffline) return;
    onPlayRelease(activeReleaseId);
    if (onTriggerToast) {
      onTriggerToast(`▶ Playing ${release.title} • Previous queue preserved`);
    }
    onClose();
  };

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
              <p className="text-xs text-zinc-400 truncate">{release.artistCredit}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Segmented Version Carousel (if multiple versions exist) */}
        {versions.length > 1 && (
          <div className="px-4 py-2.5 bg-zinc-950/60 border-b border-zinc-800/50 flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
              <span className="font-semibold text-zinc-300">Versions ({versions.length})</span>
              <span className="text-[10px] text-zinc-500">Mastering Integrity</span>
            </div>
            <div className="flex items-center space-x-2 overflow-x-auto no-scrollbar py-1">
              {versions.map((ver) => {
                const isSelected = ver.releaseId === activeReleaseId;
                return (
                  <button
                    key={ver.releaseId}
                    onClick={() => setActiveReleaseId(ver.releaseId)}
                    className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-mono shrink-0 transition-all ${
                      isSelected
                        ? 'bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] font-semibold shadow-sm'
                        : 'bg-zinc-900/80 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {!ver.isOnline && (
                      <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0" />
                    )}
                    <span>{formatVersionLabel(ver)}</span>
                    {ver.isDefault && (
                      <span className="px-1 py-0.2 rounded bg-amber-500/30 text-[9px] font-bold text-amber-300">
                        MASTER
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Offline Warning Banner */}
        {isSelectedOffline && (
          <div className="mx-4 my-2 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center space-x-2 text-rose-300 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <div className="flex-1">
              <p className="font-semibold">Drive Offline</p>
              <p className="text-[10px] text-rose-400">
                Storage drive is disconnected. Select an available online edition above.
              </p>
            </div>
          </div>
        )}

        {/* Action Row */}
        <div className="flex items-center space-x-2 px-4 py-3 bg-zinc-900/50 border-b border-zinc-800/50 shrink-0">
          <button
            onClick={handlePlayAlbum}
            disabled={isSelectedOffline}
            className="flex-1 flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-[#D4AF37] text-zinc-950 font-semibold text-xs active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Play Album</span>
          </button>
          <button
            onClick={() => onQueueRelease(activeReleaseId, true)}
            disabled={isSelectedOffline}
            className="flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ListPlus className="w-3.5 h-3.5" />
            <span>Play Next</span>
          </button>
          <button
            onClick={() => onQueueRelease(activeReleaseId, false)}
            disabled={isSelectedOffline}
            className="flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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
                    onPlayTrack(track.filePath);
                    onClose();
                  }}
                  className="flex items-center space-x-3 flex-1 min-w-0 cursor-pointer"
                >
                  <span className="text-xs font-mono text-zinc-500 w-5 text-center">
                    {track.trackNumber ?? idx + 1}
                  </span>
                  <div className="truncate flex-1">
                    <p className="text-xs font-medium text-zinc-200 truncate">{track.title}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{track.artistCredit}</p>
                  </div>
                </div>

                <div className="flex items-center space-x-2 pl-2">
                  <span className="text-[11px] font-mono text-zinc-500 flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-zinc-600" />
                    <span>{formatDuration(track.durationSecs)}</span>
                  </span>
                  <button
                    onClick={() => onQueueTrack(track.filePath, false)}
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
