export interface AudioStreamInfo {
  filePath: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  durationSecs: number;
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
  format: string;
  isHighRes: boolean;
}

export interface PlaybackStatus {
  isPlaying: boolean;
  isPaused: boolean;
  currentFile?: string | null;
  currentQueueEntryId?: string | null;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  purityMode: boolean;
  isBitPerfect: boolean;
  activeDevice?: string | null;
  streamInfo?: AudioStreamInfo | null;
}

export interface RemoteTrackItem {
  queueEntryId?: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  filePath: string;
  durationSecs: number;
  format: string;
  sampleRate?: number | null;
  bitDepth?: number | null;
  isHighRes: boolean;
}

export interface RemoteQueue {
  items: RemoteTrackItem[];
  currentIndex: number;
  currentQueueEntryId?: string;
  nextUpEndIndex?: number;
  repeatMode: 'off' | 'all' | 'one';
  isShuffle: boolean;
  revision: number;
}

export type RemoteEvent =
  | {
      type: 'STATE_CHANGE';
      is_playing: boolean;
      is_paused: boolean;
      current_file?: string | null;
      position_secs: f64_or_number;
      duration_secs: f64_or_number;
      timestamp_ms: number;
      volume: number;
      is_purity_mode: boolean;
      is_bit_perfect: boolean;
      active_device?: string | null;
      stream_info?: {
        file_path: string;
        title?: string | null;
        artist?: string | null;
        album?: string | null;
        duration_secs: number;
        sample_rate?: number | null;
        bit_depth?: number | null;
        channels?: number | null;
        format: string;
        is_high_res: boolean;
      } | null;
    }
  | {
      type: 'HEARTBEAT';
      position_secs: number;
      duration_secs: number;
      timestamp_ms: number;
      is_playing: boolean;
      rate: number;
    }
  | {
      type: 'QUEUE_UPDATED';
      items: RemoteTrackItem[];
      current_index: number;
      revision?: number;
      current_queue_entry_id?: string;
    }
  | {
      type: 'QUEUE_CONFLICT';
      current_revision: number;
      items: RemoteTrackItem[];
      current_index: number;
    }
  | {
      type: 'DEVICE_UNAVAILABLE';
      device_name: string;
      available_devices: string[];
    };

type f64_or_number = number;

export interface AlbumVersionSummary {
  releaseId: string;
  title: string;
  releaseYear?: number | null;
  formatSummary: string;
  maxSampleRate?: number | null;
  maxBitDepth?: number | null;
  avgDrScore?: number | null;
  trackCount: number;
  isDefault: boolean;
  isOnline: boolean;
  folderPath: string;
}

export interface DbRelease {
  id: string;
  title: string;
  folderPath: string;
  folderName: string;
  artistCredit: string;
  composerName?: string | null;
  releaseYear?: number | null;
  genreTags?: string | null;
  frontCoverUrl?: string | null;
  backdropUrl?: string | null;
  isCompilation: boolean;
  masterAlbumId?: string | null;
  versions?: AlbumVersionSummary[];
  hasDsd: boolean;
  hasHighRes: boolean;
  hasFlac: boolean;
}

export interface DbTrack {
  id: string;
  releaseId?: string | null;
  filePath: string;
  fileName: string;
  title: string;
  artistCredit: string;
  albumTitle: string;
  releaseYear?: number | null;
  trackNumber?: number | null;
  durationSecs: number;
  format: string;
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
  drScore?: number | null;
  hasEmbeddedArt: boolean;
  isOnline: boolean;
}

export interface ServerProfile {
  id: string;
  label: string;
  baseUrl: string;
  mDnsHost?: string;
  fallbackIps?: string[];
  port: number;
  token: string;
  certFingerprint?: string;
  trustInsecure?: boolean;
  lastConnectedAt?: number;
}

export interface DiscoveredServer {
  serviceName: string;
  hostName: string;
  mDnsHost?: string;
  ip: string;
  port: number;
  protocol: string;
  baseUrl: string;
  fingerprint?: string;
}

export type DiagnosticErrorKind =
  | 'ok'
  | 'unauthorized'
  | 'cert_mismatch'
  | 'cert_untrusted'
  | 'timeout'
  | 'connection_refused'
  | 'dns_error'
  | 'no_wifi'
  | 'vpn_active'
  | 'http_error'
  | 'config_error'
  | 'network_error';

export interface ProbeResult {
  reachable: boolean;
  authenticated: boolean;
  httpStatus: number;
  port?: number;
  service?: string;
  certFingerprint?: string;
  fingerprintMatches?: boolean | null;
  errorKind: DiagnosticErrorKind;
  errorMessage: string;
  latencyMs: number;
}

export interface NetworkDiagnostics {
  hasNetwork: boolean;
  isWifi: boolean;
  isCellular: boolean;
  isVpn: boolean;
  localIpv4s: string[];
  isBatteryOptimized: boolean;
  notificationsEnabled: boolean;
}

export interface ConnectionDiagnostic {
  kind: DiagnosticErrorKind;
  title: string;
  detail: string;
  hint?: string;
  observedFingerprint?: string;
  testedUrl?: string;
}


