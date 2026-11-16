import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';
import type {
  DiagnosticErrorKind,
  DiscoveredServer,
  EngineKind,
  NetworkDiagnostics,
  ProbeResult,
  ServerProfile,
} from '../types/remote';

export interface NativeHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  errorKind: string;
  observedFingerprint?: string;
  errorMessage?: string;
}

interface CadenceRemoteNativePlugin {
  setServerProfile(options: {
    baseUrl: string;
    token: string;
    fingerprint?: string;
    trustInsecure?: boolean;
  }): Promise<void>;
  probeServer(options: {
    baseUrl: string;
    token?: string;
    fingerprint?: string;
    trustInsecure?: boolean;
    timeoutMs?: number;
  }): Promise<ProbeResult>;
  httpRequest(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<NativeHttpResponse>;
  connectSocket(options: {
    baseUrl: string;
    token: string;
    fingerprint?: string;
    trustInsecure?: boolean;
    heartbeat?: boolean;
  }): Promise<void>;
  sendSocketCommand(options: { payload: string }): Promise<{ sent: boolean }>;
  disconnectSocket(): Promise<void>;
  setBackgroundMode(options: { background: boolean; keepMediaSession: boolean }): Promise<void>;
  setMediaSessionEnabled(options: { enabled: boolean }): Promise<void>;
  discoverServers(options?: { timeoutMs?: number }): Promise<{ servers: DiscoveredServer[] }>;
  getNetworkDiagnostics(): Promise<NetworkDiagnostics>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  openBatterySettings(): Promise<void>;
  addListener(eventName: 'socketOpen', listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'socketEvent', listenerFunc: (event: { raw: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'socketClosed', listenerFunc: (event: { code: number; reason: string }) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'socketFailure',
    listenerFunc: (event: {
      httpStatus: number;
      errorKind: string;
      message: string;
      observedFingerprint?: string;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'serviceDiscovered',
    listenerFunc: (event: DiscoveredServer) => void
  ): Promise<PluginListenerHandle>;
}

const CadenceRemote = registerPlugin<CadenceRemoteNativePlugin>('CadenceRemote');

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function syncNativeServerProfile(profile: ServerProfile | null): Promise<void> {
  if (!isNativeAndroid()) return;
  await CadenceRemote.setServerProfile({
    baseUrl: profile?.baseUrl || '',
    token: profile?.token || '',
    fingerprint: profile?.certFingerprint || '',
    trustInsecure: Boolean(profile?.trustInsecure),
  });
}

async function probeCoreNodeServer(
  cleanBase: string,
  token: string | undefined,
  fingerprint: string | undefined,
  trustInsecure: boolean,
  timeoutMs: number
): Promise<ProbeResult> {
  const t0 = performance.now();
  const sendProbe = async (
    url: string,
    opts: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }
  ): Promise<{ ok: boolean; status: number; body: string; errorKind: DiagnosticErrorKind; errorMessage?: string }> => {
    if (isNativeAndroid()) {
      const r = await CadenceRemote.httpRequest({ url, ...opts });
      return {
        ...r,
        errorKind: (r.errorKind as DiagnosticErrorKind) || 'http_error',
      };
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: text,
        errorKind: res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error',
      };
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        body: '',
        errorKind: isAbort ? 'timeout' : 'network_error',
        errorMessage: isAbort
          ? 'Connection timed out'
          : err instanceof Error
          ? err.message
          : 'Unable to reach Cadence Core',
      };
    } finally {
      window.clearTimeout(timer);
    }
  };

  void fingerprint;
  void trustInsecure;
  const healthRes = await sendProbe(`${cleanBase}/healthz`, { method: 'GET' });
  if (healthRes.status === 0) {
    return {
      reachable: false,
      authenticated: false,
      httpStatus: 0,
      errorKind: healthRes.errorKind,
      errorMessage: healthRes.errorMessage || 'Unable to reach Cadence Core',
      latencyMs: Math.round(performance.now() - t0),
    };
  }
  if (!healthRes.ok) {
    return {
      reachable: true,
      authenticated: false,
      httpStatus: healthRes.status,
      errorKind: 'http_error',
      errorMessage: `HTTP ${healthRes.status}`,
      latencyMs: Math.round(performance.now() - t0),
    };
  }

  let observedFp: string | undefined;
  let observedEngineId: string | undefined;
  let observedLibraryId: string | undefined;
  let observedLabel: string | undefined;
  try {
    const parsedHealth = JSON.parse(healthRes.body) as Record<string, unknown>;
    if (typeof parsedHealth?.tlsFingerprintSha256 === 'string') {
      observedFp = parsedHealth.tlsFingerprintSha256;
    }
    if (typeof parsedHealth?.engineId === 'string') {
      observedEngineId = parsedHealth.engineId;
    }
    if (typeof parsedHealth?.libraryId === 'string') {
      observedLibraryId = parsedHealth.libraryId;
    }
    if (typeof parsedHealth?.label === 'string') {
      observedLabel = parsedHealth.label;
    }
  } catch {
    // Allow non-fatal parse fallback; /v1/core below enforces full protocol
  }

  if (!token) {
    return {
      reachable: true,
      authenticated: false,
      httpStatus: healthRes.status,
      label: observedLabel,
      engineId: observedEngineId,
      libraryId: observedLibraryId,
      certFingerprint: observedFp,
      errorKind: 'ok',
      errorMessage: '',
      latencyMs: Math.round(performance.now() - t0),
    };
  }

  const helloRes = await sendProbe(`${cleanBase}/v1/core`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cadence-token': token,
    },
    body: JSON.stringify({
      protocolVersion: 1,
      engineId: observedEngineId,
      libraryId: observedLibraryId,
      operation: 'core.hello',
    }),
  });

  if (helloRes.status === 401 || helloRes.status === 403) {
    return {
      reachable: true,
      authenticated: false,
      httpStatus: helloRes.status,
      label: observedLabel,
      engineId: observedEngineId,
      libraryId: observedLibraryId,
      certFingerprint: observedFp,
      errorKind: 'unauthorized',
      errorMessage: 'Pairing PIN/token was rejected by Cadence Core.',
      latencyMs: Math.round(performance.now() - t0),
    };
  }
  if (helloRes.ok) {
    try {
      const parsedHello = JSON.parse(helloRes.body) as { data?: Record<string, unknown> };
      if (typeof parsedHello?.data?.engineId === 'string') {
        observedEngineId = parsedHello.data.engineId;
      }
      if (typeof parsedHello?.data?.libraryId === 'string') {
        observedLibraryId = parsedHello.data.libraryId;
      }
      if (typeof parsedHello?.data?.label === 'string') {
        observedLabel = parsedHello.data.label;
      }
    } catch {
      // Keep healthz metadata when present
    }
    return {
      reachable: true,
      authenticated: true,
      httpStatus: helloRes.status,
      label: observedLabel,
      engineId: observedEngineId,
      libraryId: observedLibraryId,
      certFingerprint: observedFp,
      errorKind: 'ok',
      errorMessage: '',
      latencyMs: Math.round(performance.now() - t0),
    };
  }
  return {
    reachable: helloRes.status > 0,
    authenticated: false,
    httpStatus: helloRes.status,
    certFingerprint: observedFp,
    errorKind: helloRes.errorKind || 'http_error',
    errorMessage: helloRes.errorMessage || `HTTP ${helloRes.status}`,
    latencyMs: Math.round(performance.now() - t0),
  };
}

export async function probeCadenceServer(
  baseUrl: string,
  token?: string,
  fingerprint?: string,
  trustInsecure = false,
  timeoutMs = 3500,
  engineKind?: EngineKind
): Promise<ProbeResult> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  if (engineKind === 'core') {
    return probeCoreNodeServer(cleanBase, token, fingerprint, trustInsecure, timeoutMs);
  }

  if (isNativeAndroid()) {
    return CadenceRemote.probeServer({
      baseUrl,
      token,
      fingerprint,
      trustInsecure,
      timeoutMs,
    });
  }

  const t0 = performance.now();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const pingRes = await fetch(`${cleanBase}/api/remote/ping`, {
      signal: controller.signal,
    });
    if (!token) {
      return {
        reachable: pingRes.ok,
        authenticated: false,
        httpStatus: pingRes.status,
        errorKind: pingRes.ok ? 'ok' : 'http_error',
        errorMessage: pingRes.ok ? '' : `HTTP ${pingRes.status}`,
        latencyMs: Math.round(performance.now() - t0),
      };
    }

    const statusRes = await fetch(
      `${cleanBase}/api/remote/status?token=${encodeURIComponent(token)}`,
      {
        headers: { 'x-cadence-token': token },
        signal: controller.signal,
      }
    );
    if (statusRes.ok) {
      return {
        reachable: true,
        authenticated: true,
        httpStatus: statusRes.status,
        errorKind: 'ok',
        errorMessage: '',
        latencyMs: Math.round(performance.now() - t0),
      };
    }
    return {
      reachable: true,
      authenticated: false,
      httpStatus: statusRes.status,
      errorKind: statusRes.status === 401 || statusRes.status === 403 ? 'unauthorized' : 'http_error',
      errorMessage:
        statusRes.status === 401 || statusRes.status === 403
          ? 'Pairing PIN was rejected by Cadence Desktop.'
          : `HTTP ${statusRes.status}`,
      latencyMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    return {
      reachable: false,
      authenticated: false,
      httpStatus: 0,
      errorKind: isAbort ? 'timeout' : 'network_error',
      errorMessage: isAbort
        ? 'Connection timed out'
        : err instanceof Error
        ? err.message
        : 'Unable to reach desktop server',
      latencyMs: Math.round(performance.now() - t0),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function nativeOrFetchHttp(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {}
): Promise<NativeHttpResponse> {
  if (isNativeAndroid()) {
    return CadenceRemote.httpRequest({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });
  }

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: text,
      errorKind: res.ok ? 'ok' : res.status === 401 ? 'unauthorized' : 'http_error',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      body: '',
      errorKind: 'network_error',
      errorMessage: err instanceof Error ? err.message : 'Network error',
    };
  }
}

export async function discoverLanDesktops(
  timeoutMs = 3000,
  onFound?: (server: DiscoveredServer) => void
): Promise<DiscoveredServer[]> {
  if (!isNativeAndroid()) {
    return [];
  }
  let handle: PluginListenerHandle | null = null;
  if (onFound) {
    handle = await CadenceRemote.addListener('serviceDiscovered', onFound);
  }
  try {
    const res = await CadenceRemote.discoverServers({ timeoutMs });
    return res.servers || [];
  } finally {
    await handle?.remove();
  }
}

export async function getAndroidNetworkDiagnostics(): Promise<NetworkDiagnostics> {
  if (!isNativeAndroid()) {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    return {
      hasNetwork: online,
      isWifi: online,
      isCellular: false,
      isVpn: false,
      localIpv4s: [],
      isBatteryOptimized: false,
      notificationsEnabled: true,
    };
  }
  return CadenceRemote.getNetworkDiagnostics();
}

export async function scanPairingQrCode(options: {
  onCameraFallbackStart?: () => void;
  onCameraFallbackStop?: () => void;
}): Promise<string | null> {
  if (!isNativeAndroid()) {
    return null;
  }

  // Prefer Google Code Scanner (no camera permission needed) when module is available
  try {
    const gms = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (gms.available) {
      const { barcodes } = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
      });
      return barcodes?.[0]?.rawValue || null;
    }
  } catch {
    // Fall through to CameraX embedded scanner
  }

  const perms = await BarcodeScanner.checkPermissions();
  let state = perms.camera;
  if (state !== 'granted') {
    const req = await BarcodeScanner.requestPermissions();
    state = req.camera;
  }
  if (state !== 'granted') {
    throw new Error('CAMERA_PERMISSION_DENIED');
  }

  return new Promise<string | null>((resolve, reject) => {
    void (async () => {
      let settled = false;
      let scanHandle: PluginListenerHandle | null = null;
      let errHandle: PluginListenerHandle | null = null;

      const cleanup = async () => {
        document.documentElement.classList.remove('cadence-qr-scanning');
        options.onCameraFallbackStop?.();
        await scanHandle?.remove();
        await errHandle?.remove();
        try {
          await BarcodeScanner.stopScan();
        } catch {
          // ignore
        }
      };

      try {
        scanHandle = await BarcodeScanner.addListener('barcodesScanned', async (event) => {
          if (settled) return;
          const raw = event.barcodes?.[0]?.rawValue;
          if (raw) {
            settled = true;
            await cleanup();
            resolve(raw);
          }
        });
        errHandle = await BarcodeScanner.addListener('scanError', async (event) => {
          if (settled) return;
          settled = true;
          await cleanup();
          reject(new Error(event.message || 'Camera scan error'));
        });

        document.documentElement.classList.add('cadence-qr-scanning');
        options.onCameraFallbackStart?.();
        await BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] });
      } catch (err) {
        if (!settled) {
          settled = true;
          await cleanup();
          reject(err);
        }
      }
    })();
  });
}

export async function cancelFallbackQrScan(): Promise<void> {
  document.documentElement.classList.remove('cadence-qr-scanning');
  if (!isNativeAndroid()) return;
  try {
    await BarcodeScanner.stopScan();
  } catch {
    // ignore
  }
}

export { CadenceRemote, CapApp };
