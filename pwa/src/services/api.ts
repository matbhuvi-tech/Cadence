import type { DbRelease, DbTrack, RemoteQueue } from '../types/remote';

export function getStoredToken(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl && tokenFromUrl.trim()) {
    localStorage.setItem('cadence_token', tokenFromUrl.trim());
    return tokenFromUrl.trim();
  }
  return localStorage.getItem('cadence_token') || '';
}

export function getArtworkUrl(id: string, token: string): string {
  if (!id) return '';
  return `/api/remote/library/artwork/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

export async function fetchReleases(token: string, limit = 150, offset = 0): Promise<DbRelease[]> {
  const res = await fetch(`/api/remote/library/releases?limit=${limit}&offset=${offset}&token=${encodeURIComponent(token)}`, {
    headers: {
      'x-cadence-token': token,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load releases: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchTracks(token: string, releaseId?: string): Promise<DbTrack[]> {
  const query = releaseId ? `?releaseId=${encodeURIComponent(releaseId)}&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`;
  const res = await fetch(`/api/remote/library/tracks${query}`, {
    headers: {
      'x-cadence-token': token,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load tracks: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchQueue(token: string): Promise<RemoteQueue> {
  const res = await fetch(`/api/remote/queue?token=${encodeURIComponent(token)}`, {
    headers: {
      'x-cadence-token': token,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load queue: ${res.statusText}`);
  }
  return res.json();
}

export async function sendPlaybackAction(
  action: 'play' | 'pause' | 'resume' | 'stop' | 'seek' | 'volume' | 'purity',
  payload: Record<string, unknown>,
  token: string
): Promise<boolean> {
  try {
    const res = await fetch(`/api/remote/playback/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cadence-token': token,
      },
      body: JSON.stringify({
        ...payload,
        token,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('Playback action error:', err);
    return false;
  }
}
