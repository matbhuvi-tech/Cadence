import { useState } from 'react';
import { QrCode, RefreshCw } from 'lucide-react';
import { useRemoteSocket } from './hooks/useRemoteSocket';
import { useMediaSession } from './hooks/useMediaSession';
import { TopHeader } from './components/Navigation/TopHeader';
import { TabBar, TabId } from './components/Navigation/TabBar';
import { NowPlayingView } from './components/NowPlaying/NowPlayingView';
import { CatalogView } from './components/Catalog/CatalogView';
import { QueueView } from './components/Queue/QueueView';

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('now_playing');

  const {
    token,
    status,
    queue,
    isConnected,
    isConnecting,
    error,
    connect,
    playPause,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    togglePurity,
    playTrack,
    playRelease,
    playTrackInRelease: _playTrackInRelease,
    queueTrack,
    queueRelease,
    jumpToQueueIndex,
    removeFromQueue,
    clearQueue,
  } = useRemoteSocket();

  // Android Chrome MediaSession Background / Lock-screen Controls
  useMediaSession({
    status,
    token,
    onPlayPause: playPause,
    onNextTrack: nextTrack,
    onPrevTrack: prevTrack,
    onSeek: seek,
  });

  // Pairing prompt if no token exists
  if (!token) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-[#0D0E11] text-zinc-100">
        <div className="w-16 h-16 rounded-3xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-[#D4AF37] mb-4 shadow-xl">
          <QrCode className="w-8 h-8" />
        </div>
        <h1 className="text-xl font-bold tracking-tight mb-2">Cadence Mobile Remote</h1>
        <p className="text-xs text-zinc-400 max-w-xs mb-6 leading-relaxed">
          To connect to your bit-perfect audio engine, scan the QR code displayed in Cadence on your desktop.
        </p>
        <button
          onClick={() => {
            const prompted = window.prompt('Or paste your Cadence Remote token:');
            if (prompted && prompted.trim()) {
              localStorage.setItem('cadence_token', prompted.trim());
              window.location.reload();
            }
          }}
          className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-[#D4AF37] hover:bg-zinc-800 active:scale-95 transition-all"
        >
          Enter Token Manually
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-[100dvh] w-full overflow-hidden bg-[#0D0E11] text-zinc-100 select-none">
      {/* Top Header */}
      <TopHeader
        status={status}
        isConnected={isConnected}
        isConnecting={isConnecting}
      />

      {/* Network / Offline Notice Banner if disconnected */}
      {error && !isConnected && (
        <div className="bg-rose-950/40 border-b border-rose-900/60 px-4 py-1.5 flex items-center justify-between text-xs text-rose-300">
          <span className="truncate">{error}</span>
          <button
            onClick={connect}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-rose-900/60 hover:bg-rose-800 text-rose-100 font-medium shrink-0 ml-2"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Main Tab View */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {activeTab === 'now_playing' && (
          <NowPlayingView
            status={status}
            token={token}
            onPlayPause={playPause}
            onNextTrack={nextTrack}
            onPrevTrack={prevTrack}
            onSeek={seek}
            onVolumeChange={setVolume}
            onTogglePurity={togglePurity}
          />
        )}

        {activeTab === 'catalog' && (
          <CatalogView
            token={token}
            onPlayRelease={playRelease}
            onQueueRelease={queueRelease}
            onPlayTrack={playTrack}
            onQueueTrack={queueTrack}
          />
        )}

        {activeTab === 'queue' && (
          <QueueView
            queue={queue}
            onJumpToIndex={jumpToQueueIndex}
            onRemoveFromQueue={removeFromQueue}
            onClearQueue={clearQueue}
          />
        )}
      </main>

      {/* Bottom Navigation Tab Bar */}
      <TabBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        queueCount={queue.items.length}
      />
    </div>
  );
}
export default App;
