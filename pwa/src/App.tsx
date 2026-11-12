import { useState, useEffect, useRef } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { RefreshCw, AlertTriangle, Speaker } from 'lucide-react';
import { useRemoteSocket } from './hooks/useRemoteSocket';
import { useMediaSession } from './hooks/useMediaSession';
import { TopHeader } from './components/Navigation/TopHeader';
import { TabBar, TabId } from './components/Navigation/TabBar';
import { MiniPlayer } from './components/Navigation/MiniPlayer';
import { NowPlayingView } from './components/NowPlaying/NowPlayingView';
import { CatalogView } from './components/Catalog/CatalogView';
import { QueueView } from './components/Queue/QueueView';
import { PairingView } from './components/Connection/PairingView';
import { DiagnosticsSheet } from './components/Connection/DiagnosticsSheet';
import { CapApp, isNativeAndroid } from './platform/cadenceBridge';

interface ToastState {
  id: number;
  message: string;
  onUndo?: () => void;
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('catalog');
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState<boolean>(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);
  const [showSwitchingPairing, setShowSwitchingPairing] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const isNowPlayingOpenRef = useRef(isNowPlayingOpen);
  const isDiagnosticsOpenRef = useRef(isDiagnosticsOpen);
  const showSwitchingPairingRef = useRef(showSwitchingPairing);

  useEffect(() => {
    isNowPlayingOpenRef.current = isNowPlayingOpen;
    isDiagnosticsOpenRef.current = isDiagnosticsOpen;
    showSwitchingPairingRef.current = showSwitchingPairing;
  }, [isNowPlayingOpen, isDiagnosticsOpen, showSwitchingPairing]);

  const {
    activeProfile,
    baseUrl,
    token,
    setToken,
    selectServerProfile,
    clearServerProfile,
    trustObservedCertificate,
    lockScreenControls,
    setLockScreenControls,
    status,
    queue,
    isConnected,
    isConnecting,
    error,
    connectionDiagnostic,
    runDiagnostics,
    probeAlternateEndpoints,
    retryConnection,
    outputDevices,
    isLoadingDevices,
    isChangingDevice,
    deviceError,
    conflictEvent,
    setConflictEvent,
    deviceUnavailableEvent,
    setDeviceUnavailableEvent,
    refreshOutputDevices,
    changeOutputDevice,
    playPause,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    togglePurity,
    playTrack,
    playRelease,
    playTrackInRelease,
    queueTrack,
    queueRelease,
    jumpToQueueIndex,
    removeFromQueue,
    clearQueue,
  } = useRemoteSocket();

  // Browser fallback MediaSession (no-op on native Android where CadenceMediaService handles lock screen)
  useMediaSession({
    status,
    token,
    baseUrl,
    onPlayPause: playPause,
    onNextTrack: nextTrack,
    onPrevTrack: prevTrack,
    onSeek: seek,
  });

  // Android hardware Back button integration for overlays & sheets
  useEffect(() => {
    if (!isNativeAndroid()) return;
    let handle: PluginListenerHandle | null = null;
    let mounted = true;
    void CapApp.addListener('backButton', ({ canGoBack }) => {
      if (showSwitchingPairingRef.current) {
        setShowSwitchingPairing(false);
      } else if (isDiagnosticsOpenRef.current) {
        setIsDiagnosticsOpen(false);
      } else if (isNowPlayingOpenRef.current) {
        if (window.history.state?.modal === 'now-playing') {
          window.history.back();
        } else {
          setIsNowPlayingOpen(false);
        }
      } else if (canGoBack) {
        window.history.back();
      } else {
        void CapApp.exitApp();
      }
    }).then((h) => {
      if (!mounted) {
        void h.remove();
      } else {
        handle = h;
      }
    });
    return () => {
      mounted = false;
      if (handle) {
        void handle.remove();
      }
    };
  }, []);

  // Auto-dismiss toast after 4.5 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = (message: string, onUndo?: () => void) => {
    setToast({
      id: Date.now(),
      message,
      onUndo,
    });
  };

  // Pairing / Desktop Discovery Screen when unpaired or switching servers
  if (!activeProfile || showSwitchingPairing) {
    return (
      <PairingView
        onPaired={(profile) => {
          selectServerProfile(profile);
          setShowSwitchingPairing(false);
        }}
        onCancel={activeProfile ? () => setShowSwitchingPairing(false) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0D0E11] text-zinc-100 select-none">
      {/* Top Header */}
      <TopHeader
        status={status}
        isConnected={isConnected}
        isConnecting={isConnecting}
        serverLabel={activeProfile.label}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
      />

      {/* Network / Offline Notice Banner with Diagnostics & Retry */}
      {error && !isConnected && (
        <div className="bg-rose-950/45 border-b border-rose-900/60 px-3 py-1.5 flex items-center justify-between gap-2 text-xs text-rose-200 shrink-0">
          <button
            type="button"
            onClick={() => setIsDiagnosticsOpen(true)}
            className="min-w-0 flex-1 text-left truncate underline decoration-rose-400/40 underline-offset-2"
          >
            {connectionDiagnostic?.title || error}
          </button>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsDiagnosticsOpen(true)}
              className="px-2.5 py-1 rounded bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 font-medium"
            >
              Details
            </button>
            <button
              type="button"
              onClick={retryConnection}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-rose-900/70 hover:bg-rose-800 text-rose-100 font-medium"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Tab View (2-Tab Model: Catalog & Queue) */}
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === 'catalog' && (
          <CatalogView
            token={token}
            baseUrl={baseUrl}
            activeTrackPath={
              status.isPlaying || status.isPaused ? (status.currentFile ?? null) : null
            }
            isPlaybackPlaying={status.isPlaying && !status.isPaused}
            onPlayRelease={playRelease}
            onQueueRelease={queueRelease}
            onPlayTrack={playTrack}
            onPlayTrackInRelease={playTrackInRelease}
            onQueueTrack={queueTrack}
            onTriggerToast={showToast}
          />
        )}

        {activeTab === 'queue' && (
          <QueueView
            queue={queue}
            status={status}
            conflictMessage={
              conflictEvent
                ? "⚠️ Queue changed while you were disconnected. Your reorder wasn't applied."
                : null
            }
            onClearConflict={() => setConflictEvent(null)}
            onResumePlayback={playPause}
            onJumpToIndex={jumpToQueueIndex}
            onRemoveFromQueue={removeFromQueue}
            onClearQueue={clearQueue}
          />
        )}
      </main>

      {/* Non-blocking Transient Action Toast with [Undo] */}
      {toast && (
        <div className="fixed bottom-24 left-4 right-4 z-[60] bg-zinc-900/95 border border-amber-500/30 text-zinc-100 px-4 py-2.5 rounded-2xl shadow-xl flex items-center justify-between backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200">
          <span className="text-xs font-medium truncate">{toast.message}</span>
          {toast.onUndo && (
            <button
              onClick={() => {
                toast.onUndo?.();
                setToast(null);
              }}
              className="ml-3 px-2.5 py-1 rounded-lg bg-amber-500/20 text-[#D4AF37] font-semibold text-xs hover:bg-amber-500/30 active:scale-95 transition-all shrink-0"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* Floating Mini-Player (Collapsible to zero height when stopped) */}
      <MiniPlayer
        status={status}
        onExpand={() => setIsNowPlayingOpen(true)}
        onPlayPause={playPause}
      />

      {/* Bottom Navigation Tab Bar (2 Tabs) */}
      <TabBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        queueCount={
          (status.isPlaying || status.isPaused) && queue.items.length > 0
            ? Math.max(0, queue.items.length - 1)
            : queue.items.length
        }
      />

      {/* Full Sheet NowPlaying Modal Overlay */}
      {isNowPlayingOpen && (
        <div className="fixed inset-0 z-50 bg-[#0D0E11] flex flex-col animate-in fade-in slide-in-from-bottom-6 duration-200">
          <NowPlayingView
            status={status}
            token={token}
            baseUrl={baseUrl}
            onClose={() => setIsNowPlayingOpen(false)}
            onPlayPause={playPause}
            onNextTrack={nextTrack}
            onPrevTrack={prevTrack}
            onSeek={seek}
            onVolumeChange={setVolume}
            onTogglePurity={togglePurity}
            outputDevices={outputDevices}
            isLoadingDevices={isLoadingDevices}
            isChangingDevice={isChangingDevice}
            deviceError={deviceError}
            onChangeOutputDevice={changeOutputDevice}
            onRefreshOutputDevices={refreshOutputDevices}
          />
        </div>
      )}

      {/* Connection Diagnostics & Android Remote Settings Sheet */}
      <DiagnosticsSheet
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        activeProfile={activeProfile}
        isConnected={isConnected}
        isConnecting={isConnecting}
        connectionDiagnostic={connectionDiagnostic}
        lockScreenControls={lockScreenControls}
        onToggleLockScreenControls={setLockScreenControls}
        onRunDiagnostics={runDiagnostics}
        onProbeAlternateEndpoints={probeAlternateEndpoints}
        onRetryConnection={retryConnection}
        onUpdatePin={setToken}
        onTrustFingerprint={trustObservedCertificate}
        onSwitchDesktop={() => {
          setIsDiagnosticsOpen(false);
          setShowSwitchingPairing(true);
        }}
        onDisconnectDesktop={() => {
          setIsDiagnosticsOpen(false);
          clearServerProfile();
        }}
      />

      {/* Hardware Device Disconnection Alert Sheet */}
      {deviceUnavailableEvent && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-[#14161C] border border-zinc-800 rounded-3xl p-5 w-full max-w-sm flex flex-col gap-4 shadow-2xl">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-zinc-100">Output Device Disconnected</h3>
                <p className="text-xs text-zinc-400 font-mono mt-0.5 truncate">
                  {deviceUnavailableEvent.deviceName}
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              The audio endpoint was disconnected or powered down. Bit-perfect playback was safely halted to prevent audio glitching or rogue OS mixer fallback.
            </p>

            <div className="flex flex-col gap-2">
              {deviceUnavailableEvent.availableDevices.length > 0 && (
                <button
                  onClick={() => {
                    const fallback = deviceUnavailableEvent.availableDevices[0];
                    changeOutputDevice(fallback);
                    setDeviceUnavailableEvent(null);
                  }}
                  className="w-full py-2.5 px-4 rounded-xl bg-[#D4AF37] text-zinc-950 font-semibold text-xs active:scale-95 transition-all flex items-center justify-center space-x-1.5"
                >
                  <Speaker className="w-4 h-4" />
                  <span>Switch to {deviceUnavailableEvent.availableDevices[0]}</span>
                </button>
              )}
              <button
                onClick={() => {
                  refreshOutputDevices();
                  changeOutputDevice(deviceUnavailableEvent.deviceName);
                  setDeviceUnavailableEvent(null);
                }}
                className="w-full py-2.5 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-xs active:scale-95 transition-all"
              >
                Reconnect & Retry
              </button>
              <button
                onClick={() => setDeviceUnavailableEvent(null)}
                className="w-full py-2 px-4 rounded-xl bg-transparent text-zinc-500 hover:text-zinc-300 text-xs active:scale-95 transition-all"
              >
                Stop & Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
