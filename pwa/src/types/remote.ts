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
  positionSecs: number;
  durationSecs: number;
  volume: number;
  purityMode: boolean;
  isBitPerfect: boolean;
  activeDevice?: string | null;
  streamInfo?: AudioStreamInfo | null;
}

export interface RemoteTrackItem {
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
  repeatMode: 'off' | 'all' | 'one';
  isShuffle: boolean;
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
    };

type f64_or_number = number;

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

