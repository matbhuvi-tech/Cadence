import {
  normalizeBaseUrl,
  extractHostAndPort,
  formatFingerprintBlocks,
  parsePairingInput,
  buildProfileCacheKey,
  loadActiveServerProfile,
  saveActiveServerProfile,
  loadSavedServerProfiles,
  removeSavedServerProfile,
  loadLockScreenControlsPref,
  saveLockScreenControlsPref,
} from '../../pwa/src/services/serverProfiles';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ Passed: ${message}`);
}

function installMockLocalStorage() {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
  (globalThis as Record<string, unknown>).localStorage = mockStorage;
  return mockStorage;
}

installMockLocalStorage();

// 1. normalizeBaseUrl & extractHostAndPort
assert(
  normalizeBaseUrl('192.168.1.42') === 'https://192.168.1.42:4040',
  'normalizeBaseUrl adds default https scheme and 4040 port'
);
assert(
  normalizeBaseUrl('http://studio-pc.local:8080/') === 'http://studio-pc.local:8080',
  'normalizeBaseUrl preserves http scheme and explicit port'
);
const extracted = extractHostAndPort('https://192.168.1.50:4041');
assert(
  extracted.scheme === 'https' && extracted.host === '192.168.1.50' && extracted.port === 4041,
  'extractHostAndPort parses host, scheme, and explicit port'
);

// 2. parsePairingInput handles enriched QR URL
const fp = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';
const qrUrl = `https://192.168.1.42:4040/?token=9182&mdns=studio-pc.local&fp=${fp}&ips=192.168.1.42,10.0.0.4`;
const parsedUrl = parsePairingInput(qrUrl);
assert(parsedUrl !== null, 'parsePairingInput parses enriched QR URL');
assert(parsedUrl?.baseUrl === 'https://192.168.1.42:4040', 'parsePairingInput extracts normalized baseUrl');
assert(parsedUrl?.token === '9182', 'parsePairingInput extracts token');
assert(parsedUrl?.mDnsHost === 'studio-pc.local', 'parsePairingInput extracts mDNS host');
assert(parsedUrl?.certFingerprint === fp.toLowerCase(), 'parsePairingInput normalizes SPKI fingerprint to lowercase');
assert(parsedUrl?.fallbackIps?.length === 2, 'parsePairingInput extracts comma-separated fallback IPs');
assert(parsedUrl?.label === 'studio-pc', 'parsePairingInput derives clean label from mDNS host');

// 3. parsePairingInput handles JSON payload format
const parsedJson = parsePairingInput(
  JSON.stringify({
    url: 'https://192.168.1.99:4040',
    token: '4321',
    host: 'Listening Room',
    mdns: 'listening.local',
    fp,
    ips: ['192.168.1.99'],
  })
);
assert(parsedJson?.baseUrl === 'https://192.168.1.99:4040', 'parsePairingInput handles JSON URL');
assert(parsedJson?.label === 'Listening Room', 'parsePairingInput uses JSON host label');

// 4. formatFingerprintBlocks & buildProfileCacheKey
assert(
  formatFingerprintBlocks('abcd1234ef56') === 'ABCD 1234 EF56',
  'formatFingerprintBlocks formats 4-character hex groups'
);
assert(
  buildProfileCacheKey('https://192.168.1.42:4040', '1111') !==
    buildProfileCacheKey('https://192.168.1.43:4040', '1111'),
  'buildProfileCacheKey isolates catalog caches across servers even with identical PINs'
);

// 5. Storage persistence for active & saved profiles and lock-screen preference
saveActiveServerProfile({
  id: 'https://192.168.1.42:4040',
  label: 'Studio PC',
  baseUrl: 'https://192.168.1.42:4040',
  mDnsHost: 'studio-pc.local',
  port: 4040,
  token: '7777',
  certFingerprint: fp.toLowerCase(),
});
const loadedNative = loadActiveServerProfile(true);
assert(loadedNative?.baseUrl === 'https://192.168.1.42:4040', 'loadActiveServerProfile restores active profile in native mode');
assert(loadSavedServerProfiles().length === 1, 'saveActiveServerProfile adds desktop to recent saved profiles');
const afterRemove = removeSavedServerProfile('https://192.168.1.42:4040');
assert(afterRemove.length === 0, 'removeSavedServerProfile deletes targeted server');

assert(loadLockScreenControlsPref() === true, 'lockScreenControls defaults to true');
saveLockScreenControlsPref(false);
assert(loadLockScreenControlsPref() === false, 'saveLockScreenControlsPref persists false');

