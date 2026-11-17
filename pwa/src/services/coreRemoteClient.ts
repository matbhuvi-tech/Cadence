import type {
  PlaybackStatus,
  RemoteQueue,
  RemoteTrackItem,
  ServerProfile,
} from '../types/remote';

export const CORE_PROTOCOL_VERSION = 1;
export const CORE_MAX_MESSAGE_BYTES = 1048576;
const REQUIRED_CAPABILITIES = [
  'catalog.read',
  'session.read',
  'playback.control',
  'queue.write',
] as const;

export type CoreErrorCode =
  | 'incompatible_protocol'
  | 'unsupported_capability'
  | 'untrusted_peer'
  | 'identity_mismatch'
  | 'not_ready'
  | 'takeover_required'
  | 'invalid_payload'
  | 'stale_revision'
  | 'unavailable';

export interface CoreHttpPostResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  errorKind: string;
  errorMessage?: string;
}

export type CorePostFn = (url: string, body: string) => Promise<CoreHttpPostResult>;

export interface CoreDescriptor {
  protocolVersion: number;
  engineId: string;
  libraryId: string;
  label: string;
  capabilities: string[];
  ready: boolean;
}

export interface CoreCatalogTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  trackNumber?: number;
  discNumber?: number;
  releaseYear?: number;
  releaseId?: string;
  albumArtist?: string;
  isCompilation?: boolean;
  edition?: string;
  composerName?: string;
  genreTags?: string[];
  folderName?: string;
  language?: string;
  hasCoverArt?: boolean;
  fingerprintStatus?: string;
}

export interface CoreExternalPlaybackInfo {
  active: boolean;
  transportState: string;
  currentUri?: string;
  positionSeconds?: number;
}

export interface CoreSnapshot {
  engineId: string;
  libraryId: string;
  revision: number;
  catalog: {
    revision: number;
    tracks: CoreCatalogTrack[];
    nextCursor: string | null;
  };
  queue: {
    entries: { entryId: string; trackId: string }[];
    currentEntryId: string | null;
    repeat: 'off' | 'one' | 'all';
    shuffle: boolean;
  };
  playback: {
    activity: 'idle' | 'playing' | 'paused' | 'loading';
    positionSeconds: number;
    owner?: 'none' | 'core' | 'external';
    takeoverRequired?: boolean;
    externalPlayback?: CoreExternalPlaybackInfo;
  };
  output: {
    id: string;
    label: string;
    transport: 'system_default' | 'wasapi' | 'upnp';
  } | null;
}

export type CoreClientCommand =
  | {
    operation: 'playback.control';
    action: 'play';
    trackId: string;
    forceTakeover?: boolean;
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'playback.control';
    action: 'pause' | 'resume' | 'stop';
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'playback.control';
    action: 'seek';
    positionSeconds: number;
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'queue.replace';
    entries: { entryId: string; trackId: string }[];
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'queue.control';
    action: 'next' | 'previous';
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'queue.control';
    action: 'jump';
    entryId: string;
    commandId: string;
    expectedRevision: number;
  }
  | {
    operation: 'queue.control';
    action: 'modes';
    repeat: 'off' | 'one' | 'all';
    shuffle: boolean;
    commandId: string;
    expectedRevision: number;
  };

export class CoreClientError extends Error {
  readonly code: CoreErrorCode;
  readonly snapshot?: CoreSnapshot;

  constructor(code: CoreErrorCode, message?: string, snapshot?: CoreSnapshot) {
    super(message || defaultMessageForCode(code));
    this.name = 'CoreClientError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

function defaultMessageForCode(code: CoreErrorCode): string {
  switch (code) {
    case 'incompatible_protocol':
      return 'Cadence Core protocol version is unsupported by this app.';
    case 'unsupported_capability':
      return 'This Cadence Core does not support a required control capability.';
    case 'untrusted_peer':
      return 'Authentication or TLS certificate trust failed for this Core.';
    case 'identity_mismatch':
      return 'The responder does not match the selected Core engine and library identity.';
    case 'not_ready':
      return 'Cadence Core is not ready yet.';
    case 'takeover_required':
      return 'RS130 is currently playing from an external controller (HiFi ROSE). Confirm takeover before starting Core playback.';
    case 'stale_revision':
      return 'Queue or playback state changed on Core. Refreshed authoritative snapshot.';
    case 'invalid_payload':
      return 'Received an invalid or oversized response from Cadence Core.';
    case 'unavailable':
      return 'Connection lost. Playback may still be continuing.';
  }
}

function assertRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new CoreClientError('invalid_payload');
  }
  return v as Record<string, unknown>;
}

function nonEmptyString(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new CoreClientError('invalid_payload');
  }
  return v.trim();
}

export function parseCoreDescriptor(
  raw: unknown,
  profile: Pick<ServerProfile, 'engineId' | 'libraryId'>
): CoreDescriptor {
  const obj = assertRecord(raw);
  if (obj.protocolVersion !== CORE_PROTOCOL_VERSION && obj.protocolVersion !== 2) {
    throw new CoreClientError('incompatible_protocol');
  }
  const engineId = nonEmptyString(obj.engineId);
  const libraryId = nonEmptyString(obj.libraryId);
  if (
    (profile.engineId && profile.engineId !== engineId) ||
    (profile.libraryId && profile.libraryId !== libraryId)
  ) {
    throw new CoreClientError('identity_mismatch');
  }
  if (!Array.isArray(obj.capabilities) || obj.capabilities.some((c) => typeof c !== 'string')) {
    throw new CoreClientError('invalid_payload');
  }
  const capabilities = obj.capabilities as string[];
  for (const reqCap of REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(reqCap)) {
      throw new CoreClientError('unsupported_capability');
    }
  }
  if (obj.ready !== true) {
    throw new CoreClientError('not_ready');
  }
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    engineId,
    libraryId,
    label: nonEmptyString(obj.label),
    capabilities,
    ready: true,
  };
}

function parseCoreCatalogTrack(item: unknown): CoreCatalogTrack {
  const t = assertRecord(item);
  if (typeof t.durationSeconds !== 'number' || !Number.isFinite(t.durationSeconds)) {
    throw new CoreClientError('invalid_payload');
  }
  return {
    id: nonEmptyString(t.id),
    title: typeof t.title === 'string' && t.title.trim() ? t.title : 'Untitled',
    artist: typeof t.artist === 'string' ? t.artist : 'Unknown Artist',
    album: typeof t.album === 'string' ? t.album : 'Unknown Album',
    durationSeconds: Math.max(0, t.durationSeconds),
    format: typeof t.format === 'string' && t.format.trim() ? t.format.trim() : undefined,
    sampleRate:
      typeof t.sampleRate === 'number' && Number.isInteger(t.sampleRate) && t.sampleRate > 0
        ? t.sampleRate
        : undefined,
    bitDepth:
      typeof t.bitDepth === 'number' && Number.isInteger(t.bitDepth) && t.bitDepth > 0
        ? t.bitDepth
        : undefined,
    trackNumber:
      typeof t.trackNumber === 'number' && Number.isInteger(t.trackNumber) && t.trackNumber > 0
        ? t.trackNumber
        : undefined,
    discNumber:
      typeof t.discNumber === 'number' && Number.isInteger(t.discNumber) && t.discNumber > 0
        ? t.discNumber
        : undefined,
    releaseYear:
      typeof t.releaseYear === 'number' && Number.isInteger(t.releaseYear) && t.releaseYear > 0
        ? t.releaseYear
        : undefined,
    releaseId:
      typeof t.releaseId === 'string' && t.releaseId.trim() ? t.releaseId.trim() : undefined,
    albumArtist:
      typeof t.albumArtist === 'string' && t.albumArtist.trim() ? t.albumArtist.trim() : undefined,
    isCompilation: typeof t.isCompilation === 'boolean' ? t.isCompilation : undefined,
    edition: typeof t.edition === 'string' && t.edition.trim() ? t.edition.trim() : undefined,
    composerName:
      typeof t.composerName === 'string' && t.composerName.trim()
        ? t.composerName.trim()
        : undefined,
    genreTags: Array.isArray(t.genreTags)
      ? t.genreTags.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
      : undefined,
    folderName:
      typeof t.folderName === 'string' && t.folderName.trim() ? t.folderName.trim() : undefined,
    language:
      typeof t.language === 'string' && t.language.trim() ? t.language.trim() : undefined,
    hasCoverArt: typeof t.hasCoverArt === 'boolean' ? t.hasCoverArt : undefined,
    fingerprintStatus:
      typeof t.fingerprintStatus === 'string' && t.fingerprintStatus.trim()
        ? t.fingerprintStatus.trim()
        : undefined,
  };
}

export function parseCoreSnapshot(
  raw: unknown,
  profile: Pick<ServerProfile, 'engineId' | 'libraryId'>
): CoreSnapshot {
  const obj = assertRecord(raw);
  const engineId = nonEmptyString(obj.engineId);
  const libraryId = nonEmptyString(obj.libraryId);
  if (
    (profile.engineId && profile.engineId !== engineId) ||
    (profile.libraryId && profile.libraryId !== libraryId)
  ) {
    throw new CoreClientError('identity_mismatch');
  }
  if (typeof obj.revision !== 'number' || !Number.isInteger(obj.revision) || obj.revision < 0) {
    throw new CoreClientError('invalid_payload');
  }

  const catalogObj = assertRecord(obj.catalog);
  if (
    typeof catalogObj.revision !== 'number' ||
    !Array.isArray(catalogObj.tracks) ||
    (catalogObj.nextCursor !== null && typeof catalogObj.nextCursor !== 'string')
  ) {
    throw new CoreClientError('invalid_payload');
  }
  const tracks: CoreCatalogTrack[] = catalogObj.tracks.map(parseCoreCatalogTrack);

  const queueObj = assertRecord(obj.queue);
  if (!Array.isArray(queueObj.entries)) {
    throw new CoreClientError('invalid_payload');
  }
  const entries = queueObj.entries.map((item) => {
    const e = assertRecord(item);
    return { entryId: nonEmptyString(e.entryId), trackId: nonEmptyString(e.trackId) };
  });
  const repeat = queueObj.repeat;
  if (repeat !== 'off' && repeat !== 'one' && repeat !== 'all') {
    throw new CoreClientError('invalid_payload');
  }
  if (typeof queueObj.shuffle !== 'boolean') {
    throw new CoreClientError('invalid_payload');
  }
  const currentEntryId =
    queueObj.currentEntryId === null ? null : nonEmptyString(queueObj.currentEntryId);

  const playbackObj = assertRecord(obj.playback);
  const activity = playbackObj.activity;
  if (
    activity !== 'idle' &&
    activity !== 'playing' &&
    activity !== 'paused' &&
    activity !== 'loading'
  ) {
    throw new CoreClientError('invalid_payload');
  }
  if (typeof playbackObj.positionSeconds !== 'number' || !Number.isFinite(playbackObj.positionSeconds)) {
    throw new CoreClientError('invalid_payload');
  }

  let owner: 'none' | 'core' | 'external' | undefined;
  if (playbackObj.owner !== undefined) {
    if (playbackObj.owner !== 'none' && playbackObj.owner !== 'core' && playbackObj.owner !== 'external') {
      throw new CoreClientError('invalid_payload');
    }
    owner = playbackObj.owner;
  }
  const takeoverRequired =
    typeof playbackObj.takeoverRequired === 'boolean' ? playbackObj.takeoverRequired : undefined;
  let externalPlayback: CoreExternalPlaybackInfo | undefined;
  if (playbackObj.externalPlayback !== undefined) {
    const ext = assertRecord(playbackObj.externalPlayback);
    if (typeof ext.active !== 'boolean' || typeof ext.transportState !== 'string') {
      throw new CoreClientError('invalid_payload');
    }
    externalPlayback = {
      active: ext.active,
      transportState: ext.transportState,
      currentUri: typeof ext.currentUri === 'string' ? ext.currentUri : undefined,
      positionSeconds:
        typeof ext.positionSeconds === 'number' && Number.isFinite(ext.positionSeconds)
          ? Math.max(0, ext.positionSeconds)
          : undefined,
    };
  }

  let output: CoreSnapshot['output'] = null;
  if (obj.output !== null && obj.output !== undefined) {
    const outObj = assertRecord(obj.output);
    const tr = outObj.transport;
    if (tr !== 'system_default' && tr !== 'wasapi' && tr !== 'upnp') {
      throw new CoreClientError('invalid_payload');
    }
    output = {
      id: nonEmptyString(outObj.id),
      label: nonEmptyString(outObj.label),
      transport: tr,
    };
  }

  return {
    engineId,
    libraryId,
    revision: obj.revision,
    catalog: {
      revision: catalogObj.revision,
      tracks,
      nextCursor: catalogObj.nextCursor,
    },
    queue: {
      entries,
      currentEntryId,
      repeat,
      shuffle: queueObj.shuffle,
    },
    playback: {
      activity,
      positionSeconds: Math.max(0, playbackObj.positionSeconds),
      ...(owner !== undefined ? { owner } : {}),
      ...(takeoverRequired !== undefined ? { takeoverRequired } : {}),
      ...(externalPlayback !== undefined ? { externalPlayback } : {}),
    },
    output,
  };
}

export function mapCoreSnapshotToPwa(snapshot: CoreSnapshot): {
  status: PlaybackStatus;
  queue: RemoteQueue;
  outputLabel: string | null;
} {
  const trackMap = new Map(snapshot.catalog.tracks.map((t) => [t.id, t]));
  const items: RemoteTrackItem[] = snapshot.queue.entries.map((entry) => {
    const trk = trackMap.get(entry.trackId);
    const rawFmt = (trk?.format || 'FLAC').toUpperCase();
    const isDsd = rawFmt === 'DSD' || rawFmt === 'DSF' || rawFmt === 'DFF';
    const isHighRes =
      isDsd || (trk?.sampleRate ?? 0) > 48000 || (trk?.bitDepth ?? 0) > 16;
    return {
      queueEntryId: entry.entryId,
      id: entry.trackId,
      title: trk?.title || entry.trackId,
      artist: trk?.artist || 'Unknown Artist',
      album: trk?.album || '',
      format: isDsd ? 'DSD' : rawFmt,
      sampleRate: trk?.sampleRate,
      bitDepth: trk?.bitDepth,
      durationSecs: trk?.durationSeconds ?? 0,
      filePath: entry.trackId,
      isHighRes,
    };
  });

  const currentIdx = snapshot.queue.currentEntryId
    ? items.findIndex((item) => item.queueEntryId === snapshot.queue.currentEntryId)
    : -1;
  const activeItem = currentIdx >= 0 ? items[currentIdx] : null;
  const isPlaying = snapshot.playback.activity === 'playing';
  const isPaused = snapshot.playback.activity === 'paused';

  const status: PlaybackStatus = {
    isPlaying,
    isPaused,
    currentFile: activeItem?.id ?? null,
    currentQueueEntryId: activeItem?.queueEntryId ?? null,
    positionSecs: snapshot.playback.positionSeconds,
    durationSecs: activeItem?.durationSecs ?? 0,
    volume: 1,
    purityMode: true,
    isBitPerfect: true,
    activeDevice: snapshot.output?.label ?? null,
    streamInfo: activeItem
      ? {
        filePath: activeItem.id,
        title: activeItem.title,
        artist: activeItem.artist,
        album: activeItem.album,
        durationSecs: activeItem.durationSecs,
        format: activeItem.format || 'FLAC',
        sampleRate: activeItem.sampleRate,
        bitDepth: activeItem.bitDepth,
        isHighRes: activeItem.isHighRes,
      }
      : null,
  };

  const queue: RemoteQueue = {
    items,
    currentIndex: currentIdx,
    currentQueueEntryId: snapshot.queue.currentEntryId ?? undefined,
    repeatMode: snapshot.queue.repeat,
    isShuffle: snapshot.queue.shuffle,
    revision: snapshot.revision,
  };

  return {
    status,
    queue,
    outputLabel: snapshot.output?.label ?? null,
  };
}

export function createPwaCoreClient(profile: ServerProfile, postJson?: CorePostFn) {
  const sendPost: CorePostFn =
    postJson ||
    (async (url, body) => {
      const { nativeOrFetchHttp } = await import('../platform/cadenceBridge');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (profile.token) {
        headers['x-cadence-token'] = profile.token;
      }
      return nativeOrFetchHttp(url, {
        method: 'POST',
        headers,
        body,
      });
    });

  let cachedDescriptor: CoreDescriptor | null = null;
  let cachedCatalogRevision: number | null = null;
  let cachedCatalogTracks: CoreCatalogTrack[] | null = null;

  async function requestCore(payload: Record<string, unknown>): Promise<unknown> {
    const endpoint = `${profile.baseUrl.replace(/\/+$/, '')}/v1/core`;
    const body = JSON.stringify({
      protocolVersion: CORE_PROTOCOL_VERSION,
      engineId: profile.engineId || '',
      libraryId: profile.libraryId || '',
      ...payload,
    });
    if (body.length > CORE_MAX_MESSAGE_BYTES) {
      throw new CoreClientError('invalid_payload');
    }

    const res = await sendPost(endpoint, body);
    if (res.status === 401 || res.status === 403 || res.errorKind === 'unauthorized' || res.errorKind === 'cert_mismatch' || res.errorKind === 'cert_untrusted') {
      throw new CoreClientError('untrusted_peer', res.errorMessage);
    }
    if (!res.ok) {
      throw new CoreClientError('unavailable', res.errorMessage || `HTTP ${res.status}`);
    }
    if (res.body.length > CORE_MAX_MESSAGE_BYTES) {
      throw new CoreClientError('invalid_payload');
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(res.body);
    } catch {
      throw new CoreClientError('invalid_payload');
    }

    const obj = assertRecord(envelope);
    if (obj.ok === true) {
      return obj.data;
    }

    const errObj = assertRecord(obj.error);
    const code = typeof errObj.code === 'string' ? errObj.code : 'unavailable';
    if (code === 'stale_revision' && errObj.snapshot) {
      const authoritative = parseCoreSnapshot(errObj.snapshot, profile);
      throw new CoreClientError('stale_revision', undefined, authoritative);
    }
    if (
      code === 'incompatible_protocol' ||
      code === 'unsupported_capability' ||
      code === 'untrusted_peer' ||
      code === 'identity_mismatch' ||
      code === 'not_ready' ||
      code === 'takeover_required' ||
      code === 'invalid_payload'
    ) {
      throw new CoreClientError(code);
    }
    throw new CoreClientError('unavailable');
  }

  async function ensureHello(force = false): Promise<CoreDescriptor> {
    if (!cachedDescriptor || force) {
      const raw = await requestCore({ operation: 'core.hello' });
      cachedDescriptor = parseCoreDescriptor(raw, profile);
    }
    return cachedDescriptor;
  }

  async function hydrateCatalog(snapshot: CoreSnapshot): Promise<CoreSnapshot> {
    if (!snapshot.catalog.nextCursor) {
      cachedCatalogRevision = snapshot.catalog.revision;
      cachedCatalogTracks = snapshot.catalog.tracks;
      return snapshot;
    }
    if (cachedCatalogTracks && cachedCatalogRevision === snapshot.catalog.revision) {
      return {
        ...snapshot,
        catalog: {
          ...snapshot.catalog,
          tracks: cachedCatalogTracks,
          nextCursor: null,
        },
      };
    }
    const merged = [...snapshot.catalog.tracks];
    const seen = new Set(merged.map((t) => t.id));
    let cursor: string | null = snapshot.catalog.nextCursor;
    let pages = 0;
    while (cursor && pages < 100) {
      pages++;
      const rawPage = await requestCore({ operation: 'catalog.page', cursor, limit: 200 });
      const pageObj = assertRecord(rawPage);
      if (!Array.isArray(pageObj.tracks)) break;
      for (const item of pageObj.tracks) {
        const parsed = parseCoreCatalogTrack(item);
        if (!seen.has(parsed.id)) {
          seen.add(parsed.id);
          merged.push(parsed);
        }
      }
      const next = pageObj.nextCursor === null ? null : typeof pageObj.nextCursor === 'string' ? pageObj.nextCursor : null;
      if (!next || next === cursor) {
        cursor = null;
      } else {
        cursor = next;
      }
    }
    cachedCatalogRevision = snapshot.catalog.revision;
    cachedCatalogTracks = merged;
    return {
      ...snapshot,
      catalog: {
        ...snapshot.catalog,
        tracks: merged,
        nextCursor: null,
      },
    };
  }

  return {
    async prepare(): Promise<{ descriptor: CoreDescriptor; snapshot: CoreSnapshot }> {
      const descriptor = await ensureHello(true);
      const rawSnap = await requestCore({ operation: 'session.snapshot' });
      const snapshot = await hydrateCatalog(parseCoreSnapshot(rawSnap, profile));
      return { descriptor, snapshot };
    },

    async getSnapshot(): Promise<CoreSnapshot> {
      await ensureHello(false);
      const rawSnap = await requestCore({ operation: 'session.snapshot' });
      return hydrateCatalog(parseCoreSnapshot(rawSnap, profile));
    },

    async execute(command: CoreClientCommand): Promise<CoreSnapshot> {
      const hello = await ensureHello(false);
      if (command.operation === 'queue.control' && !hello.capabilities.includes('queue.coordinate')) {
        throw new CoreClientError('unsupported_capability');
      }
      const rawSnap = await requestCore(command);
      return hydrateCatalog(parseCoreSnapshot(rawSnap, profile));
    },
  };
}
