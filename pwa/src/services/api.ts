import type { DbRelease, DbTrack, RemoteQueue } from '../types/remote';
import { nativeOrFetchHttp } from '../platform/cadenceBridge';

export class RemoteApiError extends Error {
  status: number;
  errorKind: string;
  observedFingerprint?: string;

  constructor(message: string, status = 0, errorKind = 'network_error', observedFingerprint?: string) {
    super(message);
    this.name = 'RemoteApiError';
    this.status = status;
    this.errorKind = errorKind;
    this.observedFingerprint = observedFingerprint;
  }
}

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl && baseUrl.trim()) {
    return baseUrl.trim().replace(/\/+$/, '');
  }
  return '';
}

async function requestJson<T>(
  path: string,
  token: string,
  baseUrl?: string,
  init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {}
): Promise<T> {
  const url = `${resolveBaseUrl(baseUrl)}${path}`;
  const headers: Record<string, string> = {
    'x-cadence-token': token,
  };
  let bodyStr: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(init.body);
  }

  const res = await nativeOrFetchHttp(url, {
    method: init.method || 'GET',
    headers,
    body: bodyStr,
  });

  if (!res.ok) {
    throw new RemoteApiError(
      res.errorMessage || res.statusText || `HTTP ${res.status}`,
      res.status,
      res.errorKind,
      res.observedFingerprint
    );
  }
  if (!res.body) {
    return undefined as T;
  }
  return JSON.parse(res.body) as T;
}

export function getArtworkUrl(id: string, token: string, baseUrl?: string): string {
  if (!id) return '';
  return `${resolveBaseUrl(baseUrl)}/api/remote/library/artwork/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

export async function fetchOutputDevices(token: string, baseUrl?: string): Promise<string[]> {
  return requestJson<string[]>(
    `/api/remote/devices?token=${encodeURIComponent(token)}`,
    token,
    baseUrl
  );
}

export async function selectOutputDevice(token: string, deviceName: string, baseUrl?: string): Promise<void> {
  await requestJson<void>(
    '/api/remote/devices',
    token,
    baseUrl,
    {
      method: 'POST',
      body: { token, deviceName },
    }
  );
}

export async function fetchReleases(
  token: string,
  limit = 150,
  offset = 0,
  baseUrl?: string
): Promise<DbRelease[]> {
  return requestJson<DbRelease[]>(
    `/api/remote/library/releases?limit=${limit}&offset=${offset}&token=${encodeURIComponent(token)}`,
    token,
    baseUrl
  );
}

export async function fetchTracks(
  token: string,
  releaseId?: string,
  baseUrl?: string
): Promise<DbTrack[]> {
  const query = releaseId
    ? `?releaseId=${encodeURIComponent(releaseId)}&token=${encodeURIComponent(token)}`
    : `?token=${encodeURIComponent(token)}`;
  return requestJson<DbTrack[]>(`/api/remote/library/tracks${query}`, token, baseUrl);
}

export async function fetchQueue(token: string, baseUrl?: string): Promise<RemoteQueue> {
  return requestJson<RemoteQueue>(
    `/api/remote/queue?token=${encodeURIComponent(token)}`,
    token,
    baseUrl
  );
}

export async function sendPlaybackAction(
  action: 'play' | 'pause' | 'resume' | 'stop' | 'seek' | 'volume' | 'purity',
  payload: Record<string, unknown>,
  token: string,
  baseUrl?: string
): Promise<boolean> {
  try {
    await requestJson<void>(`/api/remote/playback/${action}`, token, baseUrl, {
      method: 'POST',
      body: { ...payload, token },
    });
    return true;
  } catch (err) {
    console.error('Playback action error:', err);
    return false;
  }
}

export async function sendRemoteCommand(
  cmd: Record<string, unknown>,
  token: string,
  baseUrl?: string
): Promise<boolean> {
  if (!token) return false;
  try {
    await requestJson<void>(
      `/api/remote/command?token=${encodeURIComponent(token)}`,
      token,
      baseUrl,
      {
        method: 'POST',
        body: cmd,
      }
    );
    return true;
  } catch (err) {
    console.error('Remote command error:', err);
    return false;
  }
}
