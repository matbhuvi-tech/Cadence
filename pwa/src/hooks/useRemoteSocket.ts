import { useState, useEffect, useRef, useCallback } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import type {
  ConnectionDiagnostic,
  DiagnosticErrorKind,
  NetworkDiagnostics,
  PlaybackStatus,
  ProbeResult,
  RemoteEvent,
  RemoteQueue,
  RemoteTrackItem,
  ServerProfile,
} from '../types/remote';
import {
  RemoteApiError,
  fetchOutputDevices,
  fetchQueue,
  selectOutputDevice,
  sendRemoteCommand,
} from '../services/api';
import {
  CoreClientError,
  createPwaCoreClient,
  mapCoreSnapshotToPwa,
  type CoreCatalogTrack,
  type CoreClientCommand,
  type CoreOutputDevice,
  type CoreSnapshot,
} from '../services/coreRemoteClient';
import {
  extractHostAndPort,
  isSameProfileScope,
  loadActiveServerProfile,
  loadLockScreenControlsPref,
  saveActiveServerProfile,
  saveLockScreenControlsPref,
} from '../services/serverProfiles';
import {
  CadenceRemote,
  CapApp,
  getAndroidNetworkDiagnostics,
  isNativeAndroid,
  probeCadenceServer,
  syncCoreNativeMediaSession,
  syncNativeServerProfile,
} from '../platform/cadenceBridge';

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

const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 15000, 15000];
const CORE_PASSIVE_SYNC_INTERVAL_MS = 5000;
const CORE_LOADING_SETTLE_DELAY_MS = 700;
const MAX_CORE_LOADING_SETTLE_ATTEMPTS = 8;

export function hasCoreSnapshotChanged(
  prev: CoreSnapshot | null,
  next: CoreSnapshot
): boolean {
  if (!prev) return true;
  return (
    prev.revision !== next.revision ||
    prev.playback.activity !== next.playback.activity ||
    Math.floor(prev.playback.positionSeconds) !== Math.floor(next.playback.positionSeconds) ||
    prev.playback.owner !== next.playback.owner ||
    prev.playback.takeoverRequired !== next.playback.takeoverRequired ||
    Boolean(prev.playback.externalPlayback) !== Boolean(next.playback.externalPlayback) ||
    prev.catalog.revision !== next.catalog.revision ||
    prev.queue.currentEntryId !== next.queue.currentEntryId ||
    prev.queue.entries.length !== next.queue.entries.length
  );
}

function normalizeDiagnosticKind(rawKind?: string, statusCode?: number): DiagnosticErrorKind {
  if (statusCode === 401 || statusCode === 403 || rawKind === 'unauthorized') {
    return 'unauthorized';
  }
  switch (rawKind) {
    case 'ok':
    case 'cert_mismatch':
    case 'cert_untrusted':
    case 'timeout':
    case 'connection_refused':
    case 'dns_error':
    case 'no_wifi':
    case 'vpn_active':
    case 'http_error':
    case 'config_error':
    case 'network_error':
      return rawKind;
    default:
      return statusCode && statusCode >= 400 ? 'http_error' : 'network_error';
  }
}

export function buildConnectionDiagnostic(
  kind: DiagnosticErrorKind,
  detail?: string,
  testedUrl?: string,
  observedFingerprint?: string
): ConnectionDiagnostic {
  switch (kind) {
    case 'unauthorized':
      return {
        kind,
        title: 'Pairing PIN Rejected',
        detail: detail || 'Cadence Desktop rejected the pairing PIN for this server.',
        hint: 'Check the current PIN under Cadence Desktop → Mobile Remote and update it.',
        testedUrl,
      };
    case 'cert_mismatch':
      return {
        kind,
        title: 'Desktop Certificate Changed',
        detail: detail || 'The desktop TLS certificate does not match your pinned fingerprint.',
        hint: 'Compare the SHA-256 fingerprint shown below with Cadence Desktop before trusting it.',
        testedUrl,
        observedFingerprint,
      };
    case 'cert_untrusted':
      return {
        kind,
        title: 'TLS Certificate Needs Confirmation',
        detail: detail || 'The desktop self-signed certificate is not pinned yet.',
        hint: 'Verify the SHA-256 fingerprint against Cadence Desktop to establish a pinned connection.',
        testedUrl,
        observedFingerprint,
      };
    case 'timeout':
      return {
        kind,
        title: 'Desktop Server Timed Out',
        detail: detail || 'No response from Cadence Desktop on the local network.',
        hint: 'Verify Cadence Desktop is running, Mobile Remote is enabled, and Wi-Fi AP/Client Isolation is disabled on your router.',
        testedUrl,
      };
    case 'connection_refused':
      return {
        kind,
        title: 'Connection Refused by Desktop',
        detail: detail || 'Reached host IP, but nothing is accepting connections on the remote port.',
        hint: 'Ensure Mobile Remote is turned ON in Cadence Desktop and Windows Firewall allows inbound connections on Private networks.',
        testedUrl,
      };
    case 'dns_error':
      return {
        kind,
        title: 'Desktop Hostname Unresolved',
        detail: detail || 'Could not resolve the desktop hostname or .local mDNS address.',
        hint: 'Run LAN Discovery or switch to the desktop IPv4 address manually.',
        testedUrl,
      };
    case 'no_wifi':
      return {
        kind,
        title: 'Wi-Fi Is Not Connected',
        detail: detail || 'No active local Wi-Fi link detected on this phone.',
        hint: 'Connect to the same Wi-Fi network as your Cadence Desktop PC.',
        testedUrl,
      };
    case 'vpn_active':
      return {
        kind,
        title: 'VPN Tunnel Active',
        detail: detail || 'An active VPN may block local LAN routing to Cadence Desktop.',
        hint: 'Enable LAN access / split-tunneling in your VPN or temporarily pause the VPN.',
        testedUrl,
      };
    case 'config_error':
      return {
        kind,
        title: 'Invalid Desktop Configuration',
        detail: detail || 'Desktop server URL or PIN is incomplete or unsafe.',
        hint: 'Re-scan the Cadence Desktop QR code or edit the manual host URL and port.',
        testedUrl,
      };
    default:
      return {
        kind,
        title: 'Unable to Reach Cadence Desktop',
        detail: detail || 'A network error interrupted communication with Cadence Desktop.',
        hint: 'Check Wi-Fi connectivity, whether the desktop IP changed, and open Connection Diagnostics.',
        testedUrl,
        observedFingerprint,
      };
  }
}

function isFatalAuthOrTlsError(kind: DiagnosticErrorKind): boolean {
  return kind === 'unauthorized' || kind === 'cert_mismatch' || kind === 'cert_untrusted' || kind === 'config_error';
}

function mapQueueItems(rawItems: any[]): RemoteTrackItem[] {
  return rawItems.map((t: any) => ({
    ...t,
    queueEntryId: t.queueEntryId ?? t.queue_entry_id,
    filePath: t.filePath ?? t.file_path,
    durationSecs: t.durationSecs ?? t.duration_secs,
    sampleRate: t.sampleRate ?? t.sample_rate,
    bitDepth: t.bitDepth ?? t.bit_depth,
    isHighRes: t.isHighRes ?? t.is_high_res,
  }));
}

export interface DiagnosticsRunResult {
  network: NetworkDiagnostics;
  probe: ProbeResult | null;
  diagnostic: ConnectionDiagnostic | null;
}

export function useRemoteSocket() {
  const nativeAndroid = isNativeAndroid();

  const [activeProfile, setActiveProfileState] = useState<ServerProfile | null>(() =>
    loadActiveServerProfile(nativeAndroid)
  );
  const [lockScreenControls, setLockScreenControlsState] = useState<boolean>(() =>
    loadLockScreenControlsPref()
  );
  const [status, setStatus] = useState<PlaybackStatus>(INITIAL_STATUS);
  const [queue, setQueue] = useState<RemoteQueue>(INITIAL_QUEUE);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionDiagnostic, setConnectionDiagnostic] = useState<ConnectionDiagnostic | null>(null);
  const [outputDevices, setOutputDevices] = useState<string[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isChangingDevice, setIsChangingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [conflictEvent, setConflictEvent] = useState<{
    currentRevision: number;
    items: RemoteTrackItem[];
    currentIndex: number;
  } | null>(null);
  const [deviceUnavailableEvent, setDeviceUnavailableEvent] = useState<{
    deviceName: string;
    availableDevices: string[];
  } | null>(null);
  const [coreSnapshot, setCoreSnapshot] = useState<CoreSnapshot | null>(null);

  const token = activeProfile?.token || '';
  const baseUrl = activeProfile?.baseUrl || '';

  const activeProfileRef = useRef<ServerProfile | null>(activeProfile);
  const coreSnapshotRef = useRef<CoreSnapshot | null>(coreSnapshot);
  const coreClientRef = useRef<ReturnType<typeof createPwaCoreClient> | null>(null);
  const coreOutputsRef = useRef<CoreOutputDevice[]>([]);
  const corePlayerOverridesRef = useRef<{ volume?: number; purityMode?: boolean }>({});
  const lockScreenControlsRef = useRef<boolean>(lockScreenControls);
  const statusRef = useRef<PlaybackStatus>(status);
  const isConnectedRef = useRef<boolean>(isConnected);
  const isForegroundRef = useRef<boolean>(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  );
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coreLoadingSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualDisconnectRef = useRef<boolean>(false);
  const reconnectAttemptRef = useRef<number>(0);
  const autoFallbackAttemptedRef = useRef<boolean>(false);
  const fallbackRunningRef = useRef<boolean>(false);
  const prevBaseUrlRef = useRef<string>(baseUrl);
  const connectRef = useRef<((profileOverride?: ServerProfile) => Promise<void>) | null>(null);

  useEffect(() => {
    activeProfileRef.current = activeProfile;
    coreSnapshotRef.current = coreSnapshot;
    lockScreenControlsRef.current = lockScreenControls;
    statusRef.current = status;
    isConnectedRef.current = isConnected;
  }, [activeProfile, coreSnapshot, lockScreenControls, status, isConnected]);

  const applyCoreSnapshot = useCallback((snap: CoreSnapshot, targetProfile?: ServerProfile) => {
    coreSnapshotRef.current = snap;
    setCoreSnapshot(snap);
    const mapped = mapCoreSnapshotToPwa(snap, corePlayerOverridesRef.current);
    setStatus(mapped.status);
    setQueue(mapped.queue);
    if (coreOutputsRef.current.length > 0) {
      const labels = coreOutputsRef.current.map((o) => o.label);
      if (mapped.outputLabel && !labels.includes(mapped.outputLabel)) {
        labels.unshift(mapped.outputLabel);
      }
      setOutputDevices(labels);
    } else {
      setOutputDevices(mapped.outputLabel ? [mapped.outputLabel] : []);
    }
    const current = targetProfile ?? activeProfileRef.current;
    if (current && mapped.outputLabel && current.outputLabel !== mapped.outputLabel) {
      const updatedProfile: ServerProfile = { ...current, outputLabel: mapped.outputLabel };
      activeProfileRef.current = updatedProfile;
      setActiveProfileState(updatedProfile);
      saveActiveServerProfile(updatedProfile);
    }
    if (isNativeAndroid()) {
      const stream = mapped.status.streamInfo;
      void syncCoreNativeMediaSession({
        engineId: snap.engineId,
        libraryId: snap.libraryId,
        revision: snap.revision,
        isPlaying: mapped.status.isPlaying,
        isPaused: mapped.status.isPaused,
        trackId: mapped.status.currentFile || '',
        artworkId: stream?.releaseId || mapped.status.currentFile || '',
        title: stream?.title || 'Cadence',
        artist: stream?.artist || 'Cadence Playback Engine',
        album: stream?.album || '',
        positionSecs: mapped.status.positionSecs,
        durationSecs: mapped.status.durationSecs,
      });
    }
  }, []);

  const clearCoreLoadingSettleTimer = useCallback(() => {
    if (coreLoadingSettleTimerRef.current) {
      clearTimeout(coreLoadingSettleTimerRef.current);
      coreLoadingSettleTimerRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    clearCoreLoadingSettleTimer();
  }, [clearCoreLoadingSettleTimer]);

  const refreshCorePassiveSnapshot = useCallback(async (): Promise<CoreSnapshot | null> => {
    const target = activeProfileRef.current;
    const client = coreClientRef.current;
    if (
      !target ||
      target.engineKind !== 'core' ||
      !client ||
      manualDisconnectRef.current ||
      !isForegroundRef.current
    ) {
      return null;
    }
    try {
      const latest = await client.getSnapshot();
      if (
        manualDisconnectRef.current ||
        !activeProfileRef.current ||
        !isSameProfileScope(activeProfileRef.current, target)
      ) {
        return null;
      }
      if (latest.playback.activity !== 'loading') {
        clearCoreLoadingSettleTimer();
      }
      if (hasCoreSnapshotChanged(coreSnapshotRef.current, latest)) {
        applyCoreSnapshot(latest, target);
      }
      setIsConnected(true);
      setError(null);
      return latest;
    } catch {
      if (
        !manualDisconnectRef.current &&
        activeProfileRef.current &&
        isSameProfileScope(activeProfileRef.current, target) &&
        coreClientRef.current === client
      ) {
        setIsConnected(false);
        setError('Connection lost. Playback may still be continuing.');
      }
      return null;
    }
  }, [applyCoreSnapshot, clearCoreLoadingSettleTimer]);

  const scheduleCoreLoadingSettleCheck = useCallback(
    (attempt = 1) => {
      clearCoreLoadingSettleTimer();
      if (attempt > MAX_CORE_LOADING_SETTLE_ATTEMPTS) return;
      const timer = setTimeout(() => {
        coreLoadingSettleTimerRef.current = null;
        void refreshCorePassiveSnapshot().then((latest) => {
          if (
            latest?.playback.activity === 'loading' &&
            isForegroundRef.current &&
            !manualDisconnectRef.current
          ) {
            scheduleCoreLoadingSettleCheck(attempt + 1);
          }
        });
      }, CORE_LOADING_SETTLE_DELAY_MS);
      const maybeTimer = timer as unknown as { unref?: () => void };
      if (typeof maybeTimer.unref === 'function') {
        maybeTimer.unref();
      }
      coreLoadingSettleTimerRef.current = timer;
    },
    [clearCoreLoadingSettleTimer, refreshCorePassiveSnapshot]
  );

  const applyRemoteQueue = useCallback((remoteQueue: any) => {
    if (!remoteQueue || !Array.isArray(remoteQueue.items)) return;
    const mappedItems = mapQueueItems(remoteQueue.items);
    const currIdx =
      typeof remoteQueue.currentIndex === 'number'
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

  const processRemoteEvent = useCallback(
    (rawJson: string) => {
      try {
        const data: RemoteEvent = JSON.parse(rawJson);
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
            streamInfo: data.stream_info
              ? {
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
                }
              : null,
          });
        } else if (data.type === 'HEARTBEAT') {
          setStatus((prev) => ({
            ...prev,
            isPlaying: data.is_playing,
            isPaused: !data.is_playing && prev.isPaused,
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
            items: mapQueueItems(data.items || []),
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
    },
    [applyRemoteQueue]
  );

  const detachAndCloseBrowserSocket = useCallback((ws: WebSocket | null) => {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }, []);

  const refreshOutputDevices = useCallback(async () => {
    const profile = activeProfileRef.current;
    if (!profile?.baseUrl) return;
    if (profile.engineKind === 'core') {
      const client = coreClientRef.current ?? createPwaCoreClient(profile);
      coreClientRef.current = client;
      setIsLoadingDevices(true);
      setDeviceError(null);
      try {
        const outputs = await client.listOutputs();
        coreOutputsRef.current = outputs;
        const labels = outputs.map((o) => o.label);
        const activeLabel = coreSnapshotRef.current?.output?.label;
        if (activeLabel && !labels.includes(activeLabel)) {
          labels.unshift(activeLabel);
        }
        setOutputDevices(labels);
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : 'Could not load Engine outputs.');
      } finally {
        setIsLoadingDevices(false);
      }
      return;
    }
    if (!profile.token) return;
    setIsLoadingDevices(true);
    setDeviceError(null);
    try {
      setOutputDevices(await fetchOutputDevices(profile.token, profile.baseUrl));
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not load output devices.');
    } finally {
      setIsLoadingDevices(false);
    }
  }, []);

  const changeOutputDevice = useCallback(
    async (deviceName: string) => {
      const profile = activeProfileRef.current;
      if (!profile?.baseUrl || !deviceName) return;
      if (profile.engineKind === 'core') {
        const client = coreClientRef.current ?? createPwaCoreClient(profile);
        coreClientRef.current = client;
        const matched = coreOutputsRef.current.find(
          (o) => o.label === deviceName || o.id === deviceName
        );
        const targetId = matched?.id ?? deviceName;
        setIsChangingDevice(true);
        setDeviceError(null);
        try {
          await client.setOutput(targetId);
          await refreshCorePassiveSnapshot();
        } catch (err) {
          setDeviceError(err instanceof Error ? err.message : 'Could not change Engine output.');
          await refreshOutputDevices();
        } finally {
          setIsChangingDevice(false);
        }
        return;
      }
      if (!profile.token) return;
      setIsChangingDevice(true);
      setDeviceError(null);
      try {
        await selectOutputDevice(profile.token, deviceName, profile.baseUrl);
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : 'Could not change output device.');
        await refreshOutputDevices();
      } finally {
        setIsChangingDevice(false);
      }
    },
    [refreshCorePassiveSnapshot, refreshOutputDevices]
  );

  const selectServerProfile = useCallback(
    (profile: ServerProfile) => {
      clearReconnectTimer();
      manualDisconnectRef.current = false;
      reconnectAttemptRef.current = 0;
      autoFallbackAttemptedRef.current = false;

      const currentProfile = activeProfileRef.current;
      if (!currentProfile || !isSameProfileScope(currentProfile, profile)) {
        prevBaseUrlRef.current = profile.baseUrl;
        coreClientRef.current = null;
        coreSnapshotRef.current = null;
        coreOutputsRef.current = [];
        corePlayerOverridesRef.current = {};
        setCoreSnapshot(null);
        setStatus(INITIAL_STATUS);
        setQueue(INITIAL_QUEUE);
        setOutputDevices([]);
      }

      setError(null);
      setConnectionDiagnostic(null);
      setDeviceError(null);
      saveActiveServerProfile(profile);
      activeProfileRef.current = profile;
      setActiveProfileState(profile);
      void syncNativeServerProfile(profile);
    },
    [clearReconnectTimer]
  );

  const setToken = useCallback(
    (newToken: string) => {
      const cleaned = newToken.trim();
      const current = activeProfileRef.current;
      if (!current) return;
      selectServerProfile({
        ...current,
        token: cleaned,
      });
    },
    [selectServerProfile]
  );

  const trustObservedCertificate = useCallback(
    (observedFp: string) => {
      const current = activeProfileRef.current;
      if (!current || !observedFp) return;
      selectServerProfile({
        ...current,
        certFingerprint: observedFp.toLowerCase(),
        trustInsecure: false,
      });
    },
    [selectServerProfile]
  );

  const setLockScreenControls = useCallback((enabled: boolean) => {
    lockScreenControlsRef.current = enabled;
    setLockScreenControlsState(enabled);
    saveLockScreenControlsPref(enabled);
    if (isNativeAndroid()) {
      void CadenceRemote.setMediaSessionEnabled({ enabled });
    }
  }, []);

  const disconnect = useCallback(
    (manual = true) => {
      if (manual) {
        manualDisconnectRef.current = true;
      }
      clearReconnectTimer();
      detachAndCloseBrowserSocket(socketRef.current);
      socketRef.current = null;
      if (isNativeAndroid()) {
        void CadenceRemote.disconnectSocket();
      }
      setIsConnected(false);
      setIsConnecting(false);
    },
    [clearReconnectTimer, detachAndCloseBrowserSocket]
  );

  const clearServerProfile = useCallback(() => {
    disconnect(true);
    saveActiveServerProfile(null);
    activeProfileRef.current = null;
    coreClientRef.current = null;
    coreSnapshotRef.current = null;
    setCoreSnapshot(null);
    prevBaseUrlRef.current = '';
    setActiveProfileState(null);
    setStatus(INITIAL_STATUS);
    setQueue(INITIAL_QUEUE);
    setOutputDevices([]);
    setError(null);
    setConnectionDiagnostic(null);
    void syncNativeServerProfile(null);
  }, [disconnect]);

  const leaveCoreAndClear = useCallback(
    async (disposition: 'leave_core_playing' | 'stop_before_switch') => {
      const current = activeProfileRef.current;
      const client = coreClientRef.current;
      const snap = coreSnapshotRef.current;
      if (
        disposition === 'stop_before_switch' &&
        current?.engineKind === 'core' &&
        client &&
        snap
      ) {
        try {
          await client.execute({
            operation: 'playback.control',
            action: 'stop',
            commandId: `pwa_stop_${Date.now().toString(36)}`,
            expectedRevision: snap.revision,
          });
        } catch {
          setIsConnected(false);
          setError('Connection lost. Playback may still be continuing.');
          return false;
        }
      }
      clearServerProfile();
      return true;
    },
    [clearServerProfile]
  );

  const connect = useCallback(
    async (profileOverride?: ServerProfile) => {
      const target = profileOverride ?? activeProfileRef.current;
      if (!target || !target.baseUrl || (target.engineKind !== 'core' && !target.token)) {
        setIsConnecting(false);
        setIsConnected(false);
        return;
      }

      manualDisconnectRef.current = false;
      clearReconnectTimer();

      if (!isForegroundRef.current) {
        return;
      }

      setIsConnecting(true);

      // Direct Cadence Core v1/v2 control path (independent of Windows Desktop)
      if (target.engineKind === 'core') {
        try {
          await syncNativeServerProfile(target);
          const client = createPwaCoreClient(target);
          const prepared = await client.prepare();
          if (
            manualDisconnectRef.current ||
            !activeProfileRef.current ||
            !isSameProfileScope(activeProfileRef.current, target)
          ) {
            return;
          }
          coreClientRef.current = client;
          const updatedProfile: ServerProfile = {
            ...target,
            label: prepared.descriptor.label || target.label,
            engineId: prepared.descriptor.engineId,
            libraryId: prepared.descriptor.libraryId,
            capabilities: prepared.descriptor.capabilities,
            outputLabel: prepared.snapshot.output?.label ?? target.outputLabel,
          };
          applyCoreSnapshot(prepared.snapshot, updatedProfile);
          setIsConnected(true);
          setIsConnecting(false);
          setError(null);
          setConnectionDiagnostic(null);
          void refreshOutputDevices();
          if (prepared.snapshot.playback.activity === 'loading') {
            scheduleCoreLoadingSettleCheck();
          } else {
            clearCoreLoadingSettleTimer();
          }
        } catch (err) {
          // Retain Core context cleanly on disconnect/error — never auto-fallback
          setIsConnected(false);
          setIsConnecting(false);
          const message =
            err instanceof CoreClientError && err.code !== 'unavailable'
              ? err.message
              : 'Connection lost. Playback may still be continuing.';
          setError(message);
          setConnectionDiagnostic(
            buildConnectionDiagnostic(
              err instanceof CoreClientError && err.code === 'untrusted_peer'
                ? 'cert_untrusted'
                : 'network_error',
              message,
              target.baseUrl
            )
          );
        }
        return;
      }

      if (isNativeAndroid()) {
        try {
          await syncNativeServerProfile(target);
          if (
            manualDisconnectRef.current ||
            !isForegroundRef.current ||
            activeProfileRef.current?.baseUrl !== target.baseUrl ||
            activeProfileRef.current?.token !== target.token
          ) {
            return;
          }
          await CadenceRemote.connectSocket({
            baseUrl: target.baseUrl,
            token: target.token,
            fingerprint: target.certFingerprint,
            trustInsecure: Boolean(target.trustInsecure),
            heartbeat: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unable to start remote connection.';
          const diag = buildConnectionDiagnostic('config_error', msg, target.baseUrl);
          setConnectionDiagnostic(diag);
          setError(diag.title);
          setIsConnecting(false);
          setIsConnected(false);
        }
        return;
      }

      // Browser WebView / standalone PWA fallback
      detachAndCloseBrowserSocket(socketRef.current);
      socketRef.current = null;

      try {
        const parsed = new URL(target.baseUrl);
        const wsProto = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
        const wsUrl = `${wsProto}//${parsed.host}/api/remote/ws?token=${encodeURIComponent(target.token)}&heartbeat=${isForegroundRef.current ? 'true' : 'false'}`;
        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;

        ws.onopen = () => {
          if (socketRef.current !== ws) return;
          reconnectAttemptRef.current = 0;
          autoFallbackAttemptedRef.current = false;
          setIsConnected(true);
          setIsConnecting(false);
          setError(null);
          setConnectionDiagnostic(null);
          void refreshOutputDevices();
          fetchQueue(target.token, target.baseUrl).then(applyRemoteQueue).catch(() => {});
        };

        ws.onmessage = (event) => {
          if (socketRef.current !== ws) return;
          processRemoteEvent(String(event.data));
        };

        ws.onerror = () => {
          if (socketRef.current !== ws) return;
          const diag = buildConnectionDiagnostic(
            'network_error',
            'WebSocket connection to Cadence Desktop failed.',
            target.baseUrl
          );
          setConnectionDiagnostic(diag);
          setError(diag.title);
        };

        ws.onclose = (ev) => {
          if (socketRef.current !== ws) return;
          socketRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);

          const isAuthClose = ev.code === 4401 || ev.code === 1008;
          if (isAuthClose) {
            const diag = buildConnectionDiagnostic('unauthorized', undefined, target.baseUrl);
            setConnectionDiagnostic(diag);
            setError(diag.title);
            return;
          }

          if (!manualDisconnectRef.current && isForegroundRef.current) {
            const idx = Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1);
            if (reconnectAttemptRef.current < RECONNECT_DELAYS_MS.length) {
              const delay = RECONNECT_DELAYS_MS[idx];
              reconnectAttemptRef.current += 1;
              reconnectTimeoutRef.current = setTimeout(() => {
                void connectRef.current?.();
              }, delay);
            }
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid desktop URL.';
        const diag = buildConnectionDiagnostic('config_error', msg, target.baseUrl);
        setConnectionDiagnostic(diag);
        setError(diag.title);
        setIsConnecting(false);
      }
    },
    [applyRemoteQueue, clearReconnectTimer, detachAndCloseBrowserSocket, processRemoteEvent, refreshOutputDevices]
  );

  const findReachableCandidate = useCallback(
    async (current: ServerProfile): Promise<ServerProfile | null> => {
      const { scheme, host, port } = extractHostAndPort(current.baseUrl);
      const candidates: string[] = [];
      if (current.mDnsHost && current.mDnsHost.toLowerCase() !== host.toLowerCase()) {
        candidates.push(`${scheme}://${current.mDnsHost}:${port}`);
      }
      for (const ip of current.fallbackIps || []) {
        if (ip && ip.toLowerCase() !== host.toLowerCase()) {
          const cand = `${scheme}://${ip}:${port}`;
          if (!candidates.includes(cand)) candidates.push(cand);
        }
      }

      for (const candUrl of candidates) {
        if (
          manualDisconnectRef.current ||
          !isForegroundRef.current ||
          activeProfileRef.current?.baseUrl !== current.baseUrl
        ) {
          return null;
        }
        const probe = await probeCadenceServer(
          candUrl,
          current.token,
          current.certFingerprint,
          Boolean(current.trustInsecure),
          2500,
          current.engineKind
        );
        if (probe.reachable && probe.authenticated && probe.fingerprintMatches !== false) {
          const nextIps = Array.from(
            new Set([host, ...(current.fallbackIps || [])].filter(Boolean))
          );
          return {
            ...current,
            baseUrl: candUrl,
            fallbackIps: nextIps,
          };
        }
      }
      return null;
    },
    []
  );

  const probeAlternateEndpoints = useCallback(async (): Promise<boolean> => {
    const current = activeProfileRef.current;
    if (!current || fallbackRunningRef.current) return false;
    fallbackRunningRef.current = true;
    try {
      const promoted = await findReachableCandidate(current);
      if (promoted) {
        selectServerProfile(promoted);
        return true;
      }
      return false;
    } finally {
      fallbackRunningRef.current = false;
    }
  }, [findReachableCandidate, selectServerProfile]);

  const attemptFallbackAndScheduleReconnect = useCallback(
    async (kind: DiagnosticErrorKind, detail: string, observedFp?: string) => {
      const current = activeProfileRef.current;
      if (!current || manualDisconnectRef.current || !isForegroundRef.current) return;

      const diag = buildConnectionDiagnostic(kind, detail, current.baseUrl, observedFp);
      setConnectionDiagnostic(diag);
      setError(diag.title);

      if (isFatalAuthOrTlsError(kind)) {
        // Stop reconnect loops when credentials or TLS pin need user review
        return;
      }

      // Auto-probe mDNS host and secondary IPs once per disconnect episode
      if (!autoFallbackAttemptedRef.current && !fallbackRunningRef.current) {
        autoFallbackAttemptedRef.current = true;
        fallbackRunningRef.current = true;
        try {
          const promoted = await findReachableCandidate(current);
          if (promoted) {
            selectServerProfile(promoted);
            return;
          }
        } finally {
          fallbackRunningRef.current = false;
        }
      }

      if (reconnectAttemptRef.current >= RECONNECT_DELAYS_MS.length) {
        return;
      }
      const delay = RECONNECT_DELAYS_MS[reconnectAttemptRef.current];
      reconnectAttemptRef.current += 1;
      clearReconnectTimer();
      reconnectTimeoutRef.current = setTimeout(() => {
        if (!manualDisconnectRef.current && isForegroundRef.current) {
          void connect();
        }
      }, delay);
    },
    [clearReconnectTimer, connect, findReachableCandidate, selectServerProfile]
  );

  // Sync MediaSession preference with native service on startup
  useEffect(() => {
    if (isNativeAndroid()) {
      void CadenceRemote.setMediaSessionEnabled({ enabled: lockScreenControls });
    }
  }, [lockScreenControls]);

  // Persistent native Capacitor OkHttp WebSocket listeners
  useEffect(() => {
    if (!isNativeAndroid()) return;

    const handles: PluginListenerHandle[] = [];
    let cancelled = false;

    const setup = async () => {
      const hOpen = await CadenceRemote.addListener('socketOpen', () => {
        if (cancelled) return;
        reconnectAttemptRef.current = 0;
        autoFallbackAttemptedRef.current = false;
        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
        setConnectionDiagnostic(null);

        const profile = activeProfileRef.current;
        if (profile?.token && profile.baseUrl) {
          void refreshOutputDevices();
          fetchQueue(profile.token, profile.baseUrl).then(applyRemoteQueue).catch(() => {});
        }
      });

      const hEvent = await CadenceRemote.addListener('socketEvent', (ev) => {
        if (cancelled || !ev?.raw) return;
        processRemoteEvent(ev.raw);
      });

      const hClosed = await CadenceRemote.addListener('socketClosed', (ev) => {
        if (cancelled) return;
        setIsConnected(false);
        setIsConnecting(false);
        if (manualDisconnectRef.current || !isForegroundRef.current) return;

        const isAuth = ev?.code === 4401 || ev?.code === 1008;
        void attemptFallbackAndScheduleReconnect(
          isAuth ? 'unauthorized' : 'network_error',
          ev?.reason || 'Connection closed by Cadence Desktop.'
        );
      });

      const hFail = await CadenceRemote.addListener('socketFailure', (ev) => {
        if (cancelled) return;
        setIsConnected(false);
        setIsConnecting(false);
        const kind = normalizeDiagnosticKind(ev?.errorKind, ev?.httpStatus);
        void attemptFallbackAndScheduleReconnect(
          kind,
          ev?.message || 'Unable to connect to Cadence Desktop.',
          ev?.observedFingerprint
        );
      });

      if (cancelled) {
        await Promise.all([hOpen.remove(), hEvent.remove(), hClosed.remove(), hFail.remove()]);
        return;
      }
      handles.push(hOpen, hEvent, hClosed, hFail);
    };

    void setup();

    return () => {
      cancelled = true;
      handles.forEach((h) => {
        void h.remove();
      });
    };
  }, [applyRemoteQueue, attemptFallbackAndScheduleReconnect, processRemoteEvent, refreshOutputDevices]);

  // Trigger connection when active server credentials or TLS pin change
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!activeProfile?.baseUrl || (activeProfile.engineKind !== 'core' && !activeProfile.token)) {
      return;
    }

    if (isForegroundRef.current) {
      void connect(activeProfile);
    }

    return () => {
      clearReconnectTimer();
      detachAndCloseBrowserSocket(socketRef.current);
      socketRef.current = null;
      if (isNativeAndroid()) {
        void CadenceRemote.disconnectSocket();
      }
    };
  }, [
    activeProfile,
    clearReconnectTimer,
    connect,
    detachAndCloseBrowserSocket,
  ]);

  // Audiophile Core passive sync (5s foreground polling when connected; suspends on background)
  useEffect(() => {
    if (activeProfile?.engineKind !== 'core' || !isConnected) {
      clearCoreLoadingSettleTimer();
      return;
    }
    const timer = window.setInterval(() => {
      if (!isForegroundRef.current || manualDisconnectRef.current) return;
      void refreshCorePassiveSnapshot();
    }, CORE_PASSIVE_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      clearCoreLoadingSettleTimer();
    };
  }, [
    activeProfile?.id,
    activeProfile?.engineKind,
    isConnected,
    clearCoreLoadingSettleTimer,
    refreshCorePassiveSnapshot,
  ]);

  // Explicit Foreground/Background & Screen-Lock Audiophile Lifecycle
  useEffect(() => {
    const handleVisibilityTransition = (isActive: boolean) => {
      if (isForegroundRef.current === isActive) return;
      isForegroundRef.current = isActive;

      const profile = activeProfileRef.current;

      if (!isActive) {
        clearReconnectTimer();
        if (profile?.engineKind === 'core') {
          setIsConnecting(false);
          return;
        }
        if (isNativeAndroid()) {
          const hasPlayback = statusRef.current.isPlaying || statusRef.current.isPaused;
          const keepMediaSession = lockScreenControlsRef.current && hasPlayback;
          void CadenceRemote.setBackgroundMode({
            background: true,
            keepMediaSession: lockScreenControlsRef.current,
          });
          if (!keepMediaSession) {
            setIsConnected(false);
            setIsConnecting(false);
          }
        } else {
          detachAndCloseBrowserSocket(socketRef.current);
          socketRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
        }
        return;
      }

      // Returned to foreground
      reconnectAttemptRef.current = 0;
      autoFallbackAttemptedRef.current = false;

      if (!profile || manualDisconnectRef.current) {
        return;
      }

      if (profile.engineKind === 'core') {
        void connect(profile);
        return;
      }

      if (isNativeAndroid()) {
        void CadenceRemote.setBackgroundMode({
          background: false,
          keepMediaSession: lockScreenControlsRef.current,
        });

        if (isConnectedRef.current) {
          // Verify socket wasn't silently dropped by OS Doze while screen was off
          fetchQueue(profile.token, profile.baseUrl)
            .then(applyRemoteQueue)
            .catch((err) => {
              if (err instanceof RemoteApiError && isFatalAuthOrTlsError(normalizeDiagnosticKind(err.errorKind, err.status))) {
                const kind = normalizeDiagnosticKind(err.errorKind, err.status);
                const diag = buildConnectionDiagnostic(kind, err.message, profile.baseUrl, err.observedFingerprint);
                setConnectionDiagnostic(diag);
                setError(diag.title);
                disconnect(false);
                return;
              }
              void connect(profile);
            });
        } else {
          void connect(profile);
        }
      } else {
        void connect(profile);
      }
    };

    const onVisibilityChange = () => {
      handleVisibilityTransition(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    let appStateHandle: PluginListenerHandle | null = null;
    let mounted = true;
    if (isNativeAndroid()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (!mounted) return;
        handleVisibilityTransition(isActive);
      }).then((h) => {
        if (!mounted) {
          void h.remove();
        } else {
          appStateHandle = h;
        }
      });
    }

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (appStateHandle) {
        void appStateHandle.remove();
      }
    };
  }, [applyRemoteQueue, clearReconnectTimer, connect, detachAndCloseBrowserSocket, disconnect]);

  const runDiagnostics = useCallback(async (): Promise<DiagnosticsRunResult> => {
    const network = await getAndroidNetworkDiagnostics();
    const profile = activeProfileRef.current;

    if (!network.hasNetwork || (isNativeAndroid() && !network.isWifi)) {
      const diag = buildConnectionDiagnostic(
        'no_wifi',
        undefined,
        profile?.baseUrl
      );
      setConnectionDiagnostic(diag);
      return { network, probe: null, diagnostic: diag };
    }

    if (!profile?.baseUrl) {
      const diag = buildConnectionDiagnostic('config_error', 'No Cadence Desktop server configured.');
      return { network, probe: null, diagnostic: diag };
    }

    const probe = await probeCadenceServer(
      profile.baseUrl,
      profile.token,
      profile.certFingerprint,
      Boolean(profile.trustInsecure),
      3500,
      profile.engineKind
    );

    if (probe.reachable && probe.authenticated) {
      setConnectionDiagnostic(null);
      return { network, probe, diagnostic: null };
    }

    let kind = normalizeDiagnosticKind(probe.errorKind, probe.httpStatus);
    if (!probe.reachable && network.isVpn && (kind === 'timeout' || kind === 'network_error')) {
      kind = 'vpn_active';
    }
    const diag = buildConnectionDiagnostic(kind, probe.errorMessage, profile.baseUrl, probe.certFingerprint);
    setConnectionDiagnostic(diag);
    return { network, probe, diagnostic: diag };
  }, []);

  // Command dispatcher with full pinned HTTP REST fallback
  const sendCommand = useCallback(
    async (cmd: Record<string, unknown>): Promise<boolean> => {
      const profile = activeProfileRef.current;

      if (profile?.engineKind === 'core') {
        const client = coreClientRef.current ?? createPwaCoreClient(profile);
        coreClientRef.current = client;
        const snap = coreSnapshotRef.current;
        if (!snap) {
          await connect(profile);
          return false;
        }
        const action = typeof cmd.action === 'string' ? cmd.action : '';
        const makeCmdId = (tag: string) =>
          `pwa_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        // Engine v2 direct player controls (volume & purity)
        if (action === 'set_volume' && typeof cmd.volume === 'number') {
          try {
            const actual = await client.setVolume(cmd.volume);
            corePlayerOverridesRef.current = { ...corePlayerOverridesRef.current, volume: actual };
            setStatus((prev) => ({ ...prev, volume: actual }));
            return true;
          } catch {
            return false;
          }
        }
        if (action === 'toggle_purity' && typeof cmd.enabled === 'boolean') {
          try {
            const actual = await client.setPurity(cmd.enabled);
            corePlayerOverridesRef.current = { ...corePlayerOverridesRef.current, purityMode: actual };
            setStatus((prev) => ({ ...prev, purityMode: actual, isBitPerfect: actual }));
            return true;
          } catch {
            return false;
          }
        }

        const resolveReleaseTracks = (releaseId: string) => {
          const clean = releaseId.replace(/^core_rel_/, '');
          const matched = snap.catalog.tracks.filter(
            (t) =>
              t.releaseId === releaseId ||
              t.releaseId === clean ||
              `core_rel_${t.album.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'album'}` === releaseId
          );
          return matched.sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
        };

        const runCoreCommand = async (coreCmd: CoreClientCommand): Promise<CoreSnapshot | null> => {
          try {
            const updated = await client.execute(coreCmd);
            applyCoreSnapshot(updated, profile);
            setIsConnected(true);
            setError(null);
            setConflictEvent(null);
            if (updated.playback.activity === 'loading') {
              scheduleCoreLoadingSettleCheck();
            } else {
              clearCoreLoadingSettleTimer();
            }
            return updated;
          } catch (err) {
            if (err instanceof CoreClientError && err.code === 'stale_revision' && err.snapshot) {
              applyCoreSnapshot(err.snapshot, profile);
              const mapped = mapCoreSnapshotToPwa(err.snapshot, corePlayerOverridesRef.current);
              setConflictEvent({
                currentRevision: err.snapshot.revision,
                items: mapped.queue.items,
                currentIndex: mapped.queue.currentIndex,
              });
              return null;
            }
            if (
              err instanceof CoreClientError &&
              (err.code === 'takeover_required' ||
                err.code === 'not_ready' ||
                err.code === 'invalid_payload')
            ) {
              setIsConnected(true);
              setError(err.message);
              return null;
            }
            setIsConnected(false);
            setError('Connection lost. Playback may still be continuing.');
            return null;
          }
        };

        // Release-level playback (replace queue with release tracks, then play target track)
        if (
          (action === 'play_release' && typeof cmd.release_id === 'string') ||
          (action === 'play_track_in_release' &&
            typeof cmd.release_id === 'string' &&
            typeof cmd.track_id === 'string')
        ) {
          const relTracks = resolveReleaseTracks(cmd.release_id as string);
          if (relTracks.length === 0) return false;
          const targetTrackId =
            action === 'play_track_in_release' ? (cmd.track_id as string) : relTracks[0].id;
          const startIdx = Math.max(
            0,
            relTracks.findIndex((t) => t.id === targetTrackId)
          );
          const ordered = relTracks.slice(startIdx);
          const newEntries = ordered.map((t, idx) => ({
            entryId: `qe_${Date.now().toString(36)}_${idx}`,
            trackId: t.id,
          }));
          const afterQueue = await runCoreCommand({
            operation: 'queue.replace',
            entries: newEntries,
            commandId: makeCmdId('qrel'),
            expectedRevision: snap.revision,
          });
          if (!afterQueue) return false;
          const afterPlay = await runCoreCommand({
            operation: 'playback.control',
            action: 'play',
            trackId: targetTrackId,
            commandId: makeCmdId('play'),
            expectedRevision: afterQueue.revision,
          });
          return Boolean(afterPlay);
        }

        if (action === 'queue_release' && typeof cmd.release_id === 'string') {
          const relTracks = resolveReleaseTracks(cmd.release_id);
          if (relTracks.length === 0) return false;
          const added = relTracks.map((t, idx) => ({
            entryId: `qe_${Date.now().toString(36)}_${idx}`,
            trackId: t.id,
          }));
          const currIdx = snap.queue.currentEntryId
            ? snap.queue.entries.findIndex((e) => e.entryId === snap.queue.currentEntryId)
            : -1;
          const nextEntries =
            cmd.play_next === true && currIdx >= 0
              ? [
                  ...snap.queue.entries.slice(0, currIdx + 1),
                  ...added,
                  ...snap.queue.entries.slice(currIdx + 1),
                ]
              : [...snap.queue.entries, ...added];
          const updated = await runCoreCommand({
            operation: 'queue.replace',
            entries: nextEntries,
            commandId: makeCmdId('qadd'),
            expectedRevision: snap.revision,
          });
          return Boolean(updated);
        }

        const commandId = makeCmdId(action || 'cmd');
        let coreCmd: CoreClientCommand | null = null;
        if (action === 'pause' || action === 'resume' || action === 'stop') {
          coreCmd = {
            operation: 'playback.control',
            action,
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'play_track' && typeof cmd.file_path === 'string') {
          coreCmd = {
            operation: 'playback.control',
            action: 'play',
            trackId: cmd.file_path,
            ...(cmd.forceTakeover === true ? { forceTakeover: true } : {}),
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'seek' && typeof cmd.position_secs === 'number') {
          coreCmd = {
            operation: 'playback.control',
            action: 'seek',
            positionSeconds: cmd.position_secs,
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'next_track') {
          coreCmd = {
            operation: 'queue.control',
            action: 'next',
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'prev_track') {
          coreCmd = {
            operation: 'queue.control',
            action: 'previous',
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'jump_to_queue_index' && typeof cmd.index === 'number') {
          const entry = snap.queue.entries[cmd.index];
          if (entry) {
            coreCmd = {
              operation: 'queue.control',
              action: 'jump',
              entryId: entry.entryId,
              commandId,
              expectedRevision: snap.revision,
            };
          }
        } else if (action === 'queue_track' && typeof cmd.file_path === 'string') {
          const newEntry = { entryId: `qe_${Date.now().toString(36)}`, trackId: cmd.file_path };
          const currIdx = snap.queue.currentEntryId
            ? snap.queue.entries.findIndex((e) => e.entryId === snap.queue.currentEntryId)
            : -1;
          const entries =
            cmd.play_next === true && currIdx >= 0
              ? [
                  ...snap.queue.entries.slice(0, currIdx + 1),
                  newEntry,
                  ...snap.queue.entries.slice(currIdx + 1),
                ]
              : [...snap.queue.entries, newEntry];
          coreCmd = {
            operation: 'queue.replace',
            entries,
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (
          action === 'reorder_queue' &&
          typeof cmd.queue_entry_id === 'string' &&
          typeof cmd.target_queue_entry_id === 'string'
        ) {
          const fromIdx = snap.queue.entries.findIndex((e) => e.entryId === cmd.queue_entry_id);
          const toIdx = snap.queue.entries.findIndex((e) => e.entryId === cmd.target_queue_entry_id);
          if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
            const reordered = [...snap.queue.entries];
            const [moved] = reordered.splice(fromIdx, 1);
            reordered.splice(toIdx, 0, moved);
            coreCmd = {
              operation: 'queue.replace',
              entries: reordered,
              commandId,
              expectedRevision: snap.revision,
            };
          }
        } else if (action === 'remove_from_queue') {
          const filtered = snap.queue.entries.filter((e, idx) => {
            if (typeof cmd.queue_entry_id === 'string') return e.entryId !== cmd.queue_entry_id;
            if (typeof cmd.index === 'number') return idx !== cmd.index;
            if (typeof cmd.track_id === 'string') return e.trackId !== cmd.track_id;
            return true;
          });
          coreCmd = {
            operation: 'queue.replace',
            entries: filtered,
            commandId,
            expectedRevision: snap.revision,
          };
        } else if (action === 'clear_queue') {
          const kept = snap.queue.currentEntryId
            ? snap.queue.entries.filter((e) => e.entryId === snap.queue.currentEntryId)
            : [];
          coreCmd = {
            operation: 'queue.replace',
            entries: kept,
            commandId,
            expectedRevision: snap.revision,
          };
        }

        if (!coreCmd) return false;
        const updated = await runCoreCommand(coreCmd);
        return Boolean(updated);
      }

      const payload = JSON.stringify(cmd);

      if (isNativeAndroid()) {
        try {
          const { sent } = await CadenceRemote.sendSocketCommand({ payload });
          if (sent) return true;
        } catch {
          // Fall through to pinned HTTP POST fallback
        }
      } else {
        const activeSocket = socketRef.current;
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
          try {
            activeSocket.send(payload);
            return true;
          } catch (err) {
            console.error('[RemoteSocket] Send error, falling back to HTTP:', err);
          }
        }
      }

      if (!profile?.token || !profile.baseUrl) {
        return false;
      }

      const ok = await sendRemoteCommand(cmd, profile.token, profile.baseUrl);
      if (ok) {
        fetchQueue(profile.token, profile.baseUrl).then(applyRemoteQueue).catch(() => {});
        if (isForegroundRef.current && !manualDisconnectRef.current && !isConnectedRef.current) {
          void connect(profile);
        }
      }
      return ok;
    },
    [applyRemoteQueue, connect]
  );

  const playPause = useCallback((): Promise<boolean> => {
    if (status.isPlaying && !status.isPaused) {
      return sendCommand({ action: 'pause' });
    }
    if (status.isPaused && status.currentFile) {
      return sendCommand({ action: 'resume' });
    }
    if (queue.items.length > 0) {
      const idx =
        queue.currentIndex >= 0 && queue.currentIndex < queue.items.length ? queue.currentIndex : 0;
      return sendCommand({ action: 'jump_to_queue_index', index: idx });
    }
    return Promise.resolve(false);
  }, [status.isPlaying, status.isPaused, status.currentFile, queue.items.length, queue.currentIndex, sendCommand]);

  const nextTrack = useCallback(() => sendCommand({ action: 'next_track' }), [sendCommand]);
  const prevTrack = useCallback(() => sendCommand({ action: 'prev_track' }), [sendCommand]);
  const seek = useCallback(
    (positionSecs: number) => sendCommand({ action: 'seek', position_secs: positionSecs }),
    [sendCommand]
  );
  const setVolume = useCallback(
    (volume: number) => sendCommand({ action: 'set_volume', volume }),
    [sendCommand]
  );
  const togglePurity = useCallback(
    (enabled: boolean) => sendCommand({ action: 'toggle_purity', enabled }),
    [sendCommand]
  );
  const playTrack = useCallback(
    (filePath: string) => sendCommand({ action: 'play_track', file_path: filePath }),
    [sendCommand]
  );
  const playRelease = useCallback(
    (releaseId: string) => sendCommand({ action: 'play_release', release_id: releaseId }),
    [sendCommand]
  );
  const playTrackInRelease = useCallback(
    (releaseId: string, trackId: string) =>
      sendCommand({ action: 'play_track_in_release', release_id: releaseId, track_id: trackId }),
    [sendCommand]
  );
  const queueTrack = useCallback(
    (filePath: string, playNext = false) =>
      sendCommand({
        action: 'queue_track',
        file_path: filePath,
        play_next: playNext,
        expected_revision: queue.revision,
      }),
    [sendCommand, queue.revision]
  );
  const queueRelease = useCallback(
    (releaseId: string, playNext = false, playNow = false) =>
      sendCommand({
        action: 'queue_release',
        release_id: releaseId,
        play_next: playNext,
        play_now: playNow,
        expected_revision: queue.revision,
      }),
    [sendCommand, queue.revision]
  );
  const reorderQueue = useCallback(
    (queueEntryId: string, targetQueueEntryId: string) =>
      sendCommand({
        action: 'reorder_queue',
        queue_entry_id: queueEntryId,
        target_queue_entry_id: targetQueueEntryId,
        expected_revision: queue.revision,
      }),
    [sendCommand, queue.revision]
  );
  const jumpToQueueIndex = useCallback(
    (index: number) => sendCommand({ action: 'jump_to_queue_index', index }),
    [sendCommand]
  );
  const removeFromQueue = useCallback(
    (index?: number, trackId?: string, queueEntryId?: string) =>
      sendCommand({
        action: 'remove_from_queue',
        index,
        track_id: trackId,
        queue_entry_id: queueEntryId,
        expected_revision: queue.revision,
      }),
    [sendCommand, queue.revision]
  );
  const clearQueue = useCallback(
    () => sendCommand({ action: 'clear_queue', expected_revision: queue.revision }),
    [sendCommand, queue.revision]
  );

  const retryConnection = useCallback(() => {
    reconnectAttemptRef.current = 0;
    autoFallbackAttemptedRef.current = false;
    manualDisconnectRef.current = false;
    setError(null);
    setConnectionDiagnostic(null);
    void connect();
  }, [connect]);

  return {
    activeProfile,
    baseUrl,
    token,
    setToken,
    selectServerProfile,
    clearServerProfile,
    leaveCoreAndClear,
    trustObservedCertificate,
    coreSnapshot,
    coreCatalogTracks: (coreSnapshot?.catalog.tracks ?? []) as CoreCatalogTrack[],
    outputLabel: coreSnapshot?.output?.label ?? activeProfile?.outputLabel ?? status.activeDevice ?? null,
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
