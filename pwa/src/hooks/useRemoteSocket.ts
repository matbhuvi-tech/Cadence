import { useState, useEffect, useRef, useCallback } from 'react';
import type { PlaybackStatus, RemoteQueue, RemoteEvent } from '../types/remote';
import { fetchOutputDevices, fetchQueue, getStoredToken, selectOutputDevice, sendRemoteCommand } from '../services/api';

const INITIAL_STATUS: PlaybackStatus = {
  isPlaying: false,
  isPaused: false,
  currentFile: null,
  positionSecs: 0,
  durationSecs: 0,
  volume: 1.0,
  purityMode: false,
  isBitPerfect: false,
  activeDevice: null,
  streamInfo: null,
};

const INITIAL_QUEUE: RemoteQueue = {
  items: [],
  currentIndex: -1,
  repeatMode: 'off',
  isShuffle: false,
  revision: 0,
};

export function useRemoteSocket() {
  const [token, setToken] = useState<string>(getStoredToken());
  const [status, setStatus] = useState<PlaybackStatus>(INITIAL_STATUS);
  const [queue, setQueue] = useState<RemoteQueue>(INITIAL_QUEUE);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [outputDevices, setOutputDevices] = useState<string[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isChangingDevice, setIsChangingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [conflictEvent, setConflictEvent] = useState<{
    currentRevision: number;
    items: any[];
    currentIndex: number;
  } | null>(null);
  const [deviceUnavailableEvent, setDeviceUnavailableEvent] = useState<{
    deviceName: string;
    availableDevices: string[];
  } | null>(null);

  const applyRemoteQueue = useCallback((remoteQueue: any) => {
    if (!remoteQueue || !Array.isArray(remoteQueue.items)) return;
    const mappedItems = remoteQueue.items.map((t: any) => ({
      ...t,
      queueEntryId: t.queueEntryId ?? t.queue_entry_id,
      filePath: t.filePath ?? t.file_path,
      durationSecs: t.durationSecs ?? t.duration_secs,
      sampleRate: t.sampleRate ?? t.sample_rate,
      bitDepth: t.bitDepth ?? t.bit_depth,
      isHighRes: t.isHighRes ?? t.is_high_res,
    }));
    const currIdx = typeof remoteQueue.currentIndex === 'number'
      ? remoteQueue.currentIndex
      : typeof remoteQueue.current_index === 'number'
      ? remoteQueue.current_index
      : -1;
    setQueue((prev) => ({
      ...prev,
      items: mappedItems,
      currentIndex: currIdx,
      revision: remoteQueue.revision ?? prev.revision,
      currentQueueEntryId: remoteQueue.currentQueueEntryId ?? remoteQueue.current_queue_entry_id,
    }));
  }, []);

  const refreshOutputDevices = useCallback(async () => {
    if (!token) return;
    setIsLoadingDevices(true);
    setDeviceError(null);
    try {
      setOutputDevices(await fetchOutputDevices(token));
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not load output devices.');
    } finally {
      setIsLoadingDevices(false);
    }
  }, [token]);

  const changeOutputDevice = useCallback(async (deviceName: string) => {
    if (!token || !deviceName) return;
    setIsChangingDevice(true);
    setDeviceError(null);
    try {
      await selectOutputDevice(token, deviceName);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not change output device.');
      await refreshOutputDevices();
    } finally {
      setIsChangingDevice(false);
    }
  }, [token, refreshOutputDevices]);

  useEffect(() => {
    void refreshOutputDevices();
    if (token) {
      fetchQueue(token).then(applyRemoteQueue).catch(() => {});
    }
  }, [refreshOutputDevices, token, applyRemoteQueue]);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isManuallyClosedRef = useRef<boolean>(false);

  const detachAndCloseSocket = useCallback((ws: WebSocket | null) => {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }, []);

  const connect = useCallback(() => {
    if (!token) {
      setError('No pairing token found. Please scan the desktop QR code.');
      return;
    }

    if (socketRef.current && (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (socketRef.current) {
      detachAndCloseSocket(socketRef.current);
      socketRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setIsConnecting(true);
    setError(null);
    isManuallyClosedRef.current = false;

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/remote/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        if (socketRef.current !== ws) return;
        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
        if (token) {
          fetchQueue(token).then(applyRemoteQueue).catch(() => {});
        }
      };

      ws.onmessage = (event) => {
        if (socketRef.current !== ws) return;
        try {
          const data: RemoteEvent = JSON.parse(event.data);
          if (data.type === 'STATE_CHANGE') {
            setStatus({
              isPlaying: data.is_playing,
              isPaused: data.is_paused,
              currentFile: data.current_file,
              positionSecs: data.position_secs,
              durationSecs: data.duration_secs,
              volume: data.volume,
              purityMode: data.is_purity_mode,
              isBitPerfect: data.is_bit_perfect,
              activeDevice: data.active_device,
              streamInfo: data.stream_info ? {
                filePath: data.stream_info.file_path,
                title: data.stream_info.title,
                artist: data.stream_info.artist,
                album: data.stream_info.album,
                durationSecs: data.stream_info.duration_secs,
                sampleRate: data.stream_info.sample_rate,
                bitDepth: data.stream_info.bit_depth,
                channels: data.stream_info.channels,
                format: data.stream_info.format,
                isHighRes: data.stream_info.is_high_res,
              } : null,
            });
          } else if (data.type === 'HEARTBEAT') {
            setStatus((prev) => ({
              ...prev,
              isPlaying: data.is_playing,
              isPaused: false,
              positionSecs: data.position_secs,
              durationSecs: data.duration_secs,
            }));
          } else if (data.type === 'QUEUE_UPDATED') {
            applyRemoteQueue(data);
            setConflictEvent(null);
          } else if (data.type === 'QUEUE_CONFLICT') {
            applyRemoteQueue(data);
            const currIdx = typeof data.current_index === 'number' ? data.current_index : -1;
            setConflictEvent({
              currentRevision: data.current_revision,
              items: (data.items || []).map((t: any) => ({
                ...t,
                queueEntryId: t.queueEntryId ?? t.queue_entry_id,
                filePath: t.filePath ?? t.file_path,
                durationSecs: t.durationSecs ?? t.duration_secs,
                sampleRate: t.sampleRate ?? t.sample_rate,
                bitDepth: t.bitDepth ?? t.bit_depth,
                isHighRes: t.isHighRes ?? t.is_high_res,
              })),
              currentIndex: currIdx,
            });
          } else if (data.type === 'DEVICE_UNAVAILABLE') {
            setDeviceUnavailableEvent({
              deviceName: data.device_name,
              availableDevices: data.available_devices,
            });
          }
        } catch (err) {
          console.error('[RemoteSocket] Parse error:', err);
        }
      };

      ws.onerror = () => {
        if (socketRef.current !== ws) return;
        setError('Connection error. Reconnecting when visible...');
      };

      ws.onclose = () => {
        if (socketRef.current !== ws) return;
        socketRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);

        // Audiophile Guard: Do not reconnect if the handset screen is asleep / hidden
        if (!isManuallyClosedRef.current && document.visibilityState === 'visible') {
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 3000);
        }
      };
    } catch (e) {
      console.error('[RemoteSocket] Setup error:', e);
      setIsConnecting(false);
      setError('Unable to initialize connection.');
    }
  }, [token, applyRemoteQueue, detachAndCloseSocket]);

  const disconnect = useCallback(() => {
    isManuallyClosedRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const ws = socketRef.current;
    socketRef.current = null;
    detachAndCloseSocket(ws);
    setIsConnected(false);
    setIsConnecting(false);
  }, [detachAndCloseSocket]);

  // Audiophile Network Purity: Handle Mobile Background Sleep & Handset Wakeup
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Suspend all continuous WebSocket radio activity immediately while asleep
        disconnect();
      } else if (document.visibilityState === 'visible') {
        // Resume single clean connection on handset wakeup
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [connect, disconnect]);

  // Initial connection
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Command dispatcher with full HTTP REST fallback
  const sendCommand = useCallback(async (cmd: Record<string, unknown>): Promise<boolean> => {
    const activeSocket = socketRef.current;
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      try {
        activeSocket.send(JSON.stringify(cmd));
        return true;
      } catch (err) {
        console.error('[RemoteSocket] Send error, falling back to HTTP:', err);
      }
    }

    if (!token) {
      return false;
    }

    const ok = await sendRemoteCommand(cmd, token);
    if (ok) {
      fetchQueue(token).then(applyRemoteQueue).catch(() => {});
      if (document.visibilityState === 'visible' && !isManuallyClosedRef.current) {
        connect();
      }
    }
    return ok;
  }, [token, applyRemoteQueue, connect]);

  const playPause = useCallback((): Promise<boolean> => {
    if (status.isPlaying && !status.isPaused) {
      return sendCommand({ action: 'pause' });
    }
    if (status.isPaused && status.currentFile) {
      return sendCommand({ action: 'resume' });
    }
    if (queue.items.length > 0) {
      const idx =
        queue.currentIndex >= 0 && queue.currentIndex < queue.items.length
          ? queue.currentIndex
          : 0;
      return sendCommand({ action: 'jump_to_queue_index', index: idx });
    }
    return Promise.resolve(false);
  }, [status.isPlaying, status.isPaused, status.currentFile, queue.items.length, queue.currentIndex, sendCommand]);

  const nextTrack = useCallback(() => {
    return sendCommand({ action: 'next_track' });
  }, [sendCommand]);

  const prevTrack = useCallback(() => {
    return sendCommand({ action: 'prev_track' });
  }, [sendCommand]);

  const seek = useCallback((positionSecs: number) => {
    return sendCommand({ action: 'seek', position_secs: positionSecs });
  }, [sendCommand]);

  const setVolume = useCallback((volume: number) => {
    return sendCommand({ action: 'set_volume', volume });
  }, [sendCommand]);

  const togglePurity = useCallback((enabled: boolean) => {
    return sendCommand({ action: 'toggle_purity', enabled });
  }, [sendCommand]);

  const playTrack = useCallback((filePath: string) => {
    return sendCommand({ action: 'play_track', file_path: filePath });
  }, [sendCommand]);

  const playRelease = useCallback((releaseId: string) => {
    return sendCommand({ action: 'play_release', release_id: releaseId });
  }, [sendCommand]);

  const playTrackInRelease = useCallback((releaseId: string, trackId: string) => {
    return sendCommand({ action: 'play_track_in_release', release_id: releaseId, track_id: trackId });
  }, [sendCommand]);

  const queueTrack = useCallback((filePath: string, playNext = false) => {
    return sendCommand({ action: 'queue_track', file_path: filePath, play_next: playNext, expected_revision: queue.revision });
  }, [sendCommand, queue.revision]);

  const queueRelease = useCallback((releaseId: string, playNext = false, playNow = false) => {
    return sendCommand({
      action: 'queue_release',
      release_id: releaseId,
      play_next: playNext,
      play_now: playNow,
      expected_revision: queue.revision,
    });
  }, [sendCommand, queue.revision]);

  const reorderQueue = useCallback((queueEntryId: string, targetQueueEntryId: string) => {
    return sendCommand({
      action: 'reorder_queue',
      queue_entry_id: queueEntryId,
      target_queue_entry_id: targetQueueEntryId,
      expected_revision: queue.revision,
    });
  }, [sendCommand, queue.revision]);

  const jumpToQueueIndex = useCallback((index: number) => {
    return sendCommand({ action: 'jump_to_queue_index', index });
  }, [sendCommand]);

  const removeFromQueue = useCallback((index?: number, trackId?: string, queueEntryId?: string) => {
    return sendCommand({
      action: 'remove_from_queue',
      index,
      track_id: trackId,
      queue_entry_id: queueEntryId,
      expected_revision: queue.revision,
    });
  }, [sendCommand, queue.revision]);

  const clearQueue = useCallback(() => {
    return sendCommand({ action: 'clear_queue', expected_revision: queue.revision });
  }, [sendCommand, queue.revision]);

  return {
    token,
    setToken,
    status,
    queue,
    isConnected,
    isConnecting,
    error,
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
    connect,
    disconnect,
    sendCommand,
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
    reorderQueue,
    jumpToQueueIndex,
    removeFromQueue,
    clearQueue,
  };
}
