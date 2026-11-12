import type { ServerProfile } from '../types/remote';

const ACTIVE_PROFILE_KEY = 'cadence_active_profile';
const SAVED_PROFILES_KEY = 'cadence_saved_profiles';
const LEGACY_TOKEN_KEY = 'cadence_token';
const LOCK_SCREEN_PREF_KEY = 'cadence_lock_screen_controls';

export function normalizeBaseUrl(rawInput: string, defaultPort = 4040, defaultScheme: 'https' | 'http' = 'https'): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultScheme}://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const scheme = parsed.protocol === 'http:' ? 'http' : 'https';
    const port = parsed.port || String(defaultPort);
    return `${scheme}://${parsed.hostname}:${port}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function extractHostAndPort(baseUrl: string): { host: string; port: number; scheme: 'https' | 'http' } {
  try {
    const parsed = new URL(baseUrl);
    const scheme = parsed.protocol === 'http:' ? 'http' : 'https';
    const port = parsed.port ? Number(parsed.port) : scheme === 'http' ? 80 : 4040;
    return { host: parsed.hostname, port, scheme };
  } catch {
    return { host: '', port: 4040, scheme: 'https' };
  }
}

export function formatFingerprintBlocks(fp?: string): string {
  if (!fp) return '';
  const clean = fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

export function parsePairingInput(raw: string): Partial<ServerProfile> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. JSON payload format
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const rawUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl : typeof obj.url === 'string' ? obj.url : '';
      if (!rawUrl) return null;
      const baseUrl = normalizeBaseUrl(rawUrl);
      const { host, port } = extractHostAndPort(baseUrl);
      return {
        baseUrl,
        port,
        label: typeof obj.host === 'string' && obj.host ? obj.host : host,
        token: typeof obj.token === 'string' ? obj.token.trim() : '',
        mDnsHost: typeof obj.mdns === 'string' ? obj.mdns.trim() : undefined,
        certFingerprint: typeof obj.fp === 'string' ? obj.fp.trim().toLowerCase() : undefined,
        fallbackIps: Array.isArray(obj.ips) ? obj.ips.map(String) : undefined,
      };
    } catch {
      return null;
    }
  }

  // 2. Enriched pairing URL: https://192.168.1.42:4040/?token=9182&mdns=pc.local&fp=...&ips=...
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const scheme = url.protocol === 'http:' ? 'http' : 'https';
    const port = url.port ? Number(url.port) : 4040;
    const baseUrl = `${scheme}://${url.hostname}:${port}`;
    const token = (url.searchParams.get('token') || '').trim();
    const mDnsHost = (url.searchParams.get('mdns') || '').trim() || undefined;
    const certFingerprint = (url.searchParams.get('fp') || '').trim().toLowerCase() || undefined;
    const ipsParam = (url.searchParams.get('ips') || '').trim();
    const fallbackIps = ipsParam
      ? ipsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const label = mDnsHost ? mDnsHost.replace(/\.local$/i, '') : url.hostname;

    return {
      baseUrl,
      port,
      label,
      token,
      mDnsHost,
      certFingerprint,
      fallbackIps,
      trustInsecure: scheme === 'http' ? true : undefined,
    };
  } catch {
    return null;
  }
}

export function buildProfileCacheKey(baseUrl: string, token: string): string {
  return `${baseUrl || 'same-origin'}::${token}`;
}

export function loadActiveServerProfile(isNative: boolean): ServerProfile | null {
  // Check URL query params first when loaded in browser mode from the desktop server
  if (!isNative && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token')?.trim();
    if (urlToken) {
      const origin = window.location.origin;
      const { host, port } = extractHostAndPort(origin);
      const profile: ServerProfile = {
        id: origin,
        label: host || 'Cadence Desktop',
        baseUrl: origin,
        mDnsHost: params.get('mdns')?.trim() || undefined,
        certFingerprint: params.get('fp')?.trim().toLowerCase() || undefined,
        fallbackIps: params.get('ips')?.split(',').map((s) => s.trim()).filter(Boolean),
        port,
        token: urlToken,
        lastConnectedAt: Date.now(),
      };
      saveActiveServerProfile(profile);
      return profile;
    }
  }

  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ServerProfile;
      if (parsed && parsed.baseUrl && parsed.token) {
        return parsed;
      }
    }
  } catch {
    // ignore corrupted storage
  }

  // Legacy browser-only token fallback
  if (!isNative && typeof window !== 'undefined') {
    const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY)?.trim();
    if (legacyToken) {
      const origin = window.location.origin;
      const { host, port } = extractHostAndPort(origin);
      return {
        id: origin,
        label: host || 'Cadence Desktop',
        baseUrl: origin,
        port,
        token: legacyToken,
      };
    }
  }

  return null;
}

export function saveActiveServerProfile(profile: ServerProfile | null): void {
  if (!profile) {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
    return;
  }
  const normalized: ServerProfile = {
    ...profile,
    id: profile.baseUrl,
    lastConnectedAt: Date.now(),
  };
  localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(normalized));
  localStorage.setItem(LEGACY_TOKEN_KEY, normalized.token);

  const existing = loadSavedServerProfiles();
  const filtered = existing.filter((p) => p.baseUrl !== normalized.baseUrl);
  const updated = [normalized, ...filtered].slice(0, 6);
  localStorage.setItem(SAVED_PROFILES_KEY, JSON.stringify(updated));
}

export function loadSavedServerProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(SAVED_PROFILES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((p) => p && p.baseUrl) : [];
  } catch {
    return [];
  }
}

export function removeSavedServerProfile(baseUrl: string): ServerProfile[] {
  const next = loadSavedServerProfiles().filter((p) => p.baseUrl !== baseUrl);
  localStorage.setItem(SAVED_PROFILES_KEY, JSON.stringify(next));
  return next;
}

export function loadLockScreenControlsPref(): boolean {
  const val = localStorage.getItem(LOCK_SCREEN_PREF_KEY);
  return val === null ? true : val === 'true';
}

export function saveLockScreenControlsPref(enabled: boolean): void {
  localStorage.setItem(LOCK_SCREEN_PREF_KEY, enabled ? 'true' : 'false');
}

