/**
 * src/services/agentTypes.ts
 * Unified Single-Source-of-Truth schema for Cadence Copilot (AI Pilot).
 */

import { CanvasViewMode } from '../core/types'

export type AgentToolName =
  | 'filter_catalog'
  | 'switch_view'
  | 'run_audit'
  | 'remediate_issue'
  | 'rework_backdrop'
  | 'select_track'
  | 'open_modal'
  | 'get_statistics'
  | 'reset_filters'
  | 'stage_metadata'
  | 'execute_pipeline'
  | 'resolve_work_hierarchy'
  | 'compare_variant_pressings'
  | 'detect_transcode_anomalies'
  | 'synthesize_normalization_rule'
  | 'preview_path_restructure'
  | 'curate_sonic_session'
  | 'query_graph'

export type RemediationActionType =
  | 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER'
  | 'MERGE_DUPLICATE_PERFORMERS'
  | 'NORMALIZE_GENRES'
  | 'FETCH_HIRES_ART'
  | 'SYNC_FOLDER_TO_ALBUM'
  | 'REWORK_BACKDROP'
  | 'APPLY_BACKDROP'
  | 'NORMALIZE_ARTIST_NAMES'
  | 'AUTOGEN_TRACK_NUMBERS'
  | 'FILL_MISSING_METADATA'

export type SupportedModalName =
  | 'import'
  | 'commit'
  | 'path_rules'
  | 'batch_diff'
  | 'customize'
  | 'customize_album'
  | 'sidecar_export'
  | 'storage_manager'
  | 'quarantine_log'
  | 'audio_device'

export interface ToolArgumentMap {
  filter_catalog: {
    composer?: string
    artist?: string
    era?: string
    language?: string
    format?: 'FLAC' | 'DSD' | 'WAV' | 'ALAC' | 'MP3' | 'AIFF' | string
    genre?: string
    mastering?: 'high_res_24bit' | 'standard_16bit' | 'dsd_direct' | string
    searchQuery?: string
  }
  switch_view: {
    viewMode: CanvasViewMode
  }
  run_audit: {
    scopeTrackIds?: string[]
  }
  remediate_issue: {
    actionType: RemediationActionType | string
    provider?: 'apple' | 'musicbrainz' | 'ai'
    trackIds?: string[]
    releaseId?: string
    targetName?: string
    [key: string]: any
  }
  rework_backdrop: {
    composer?: string
    artist?: string
    releaseId?: string
    provider?: 'apple' | 'musicbrainz' | 'ai'
    sourceArtUrl?: string
    width?: number
    height?: number
  }
  select_track: {
    trackId?: string
    query?: string
  }
  open_modal: {
    modalName: SupportedModalName | string
    payload?: any
  }
  get_statistics: {
    scope?: 'full' | 'filtered'
  }
  reset_filters: Record<string, never>
  stage_metadata: {
    coverArtUrl?: string
    backdropUrl?: string
    actionType?: string
    provider?: 'apple' | 'musicbrainz' | 'ai'
    [key: string]: any
  }
  execute_pipeline: {
    commands: AgentActionCommand[]
    stopOnError?: boolean
    atomic?: boolean
  }
  resolve_work_hierarchy: {
    releaseId?: string
    query?: string
    strategy?: 'classical_movement' | 'soundtrack_performers' | 'auto'
  }
  compare_variant_pressings: {
    releaseId?: string
    albumTitle?: string
  }
  detect_transcode_anomalies: {
    scopeTrackIds?: string[]
    thresholdKhz?: number
  }
  synthesize_normalization_rule: {
    pattern: string
    canonical: string
    category: 'artist' | 'genre' | 'composer'
  }
  preview_path_restructure: {
    pattern: string
  }
  curate_sonic_session: {
    minDrScore?: number
    format?: 'FLAC' | 'DSD' | 'WAV' | string
    durationMinutes?: number
    genres?: string[]
  }
  query_graph: {
    filter: Record<string, any>
    limit?: number
  }
}

export interface AgentActionCommand<T extends AgentToolName = AgentToolName> {
  id?: string
  tool: T
  args: T extends keyof ToolArgumentMap ? ToolArgumentMap[T] : Record<string, any>
  explanation?: string
  optional?: boolean
}

export type PipelineExecutionMode = 'sequential' | 'parallel'
export type PipelineFailureStrategy = 'stop_on_error' | 'continue_on_error' | 'rollback_on_error'

export interface AgentActionPipeline {
  id: string
  title: string
  description?: string
  executionMode?: PipelineExecutionMode
  failureStrategy?: PipelineFailureStrategy
  atomic?: boolean
  steps: AgentActionCommand[]
}

export type StepExecutionStatus =
  | 'pending'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rolled_back'

export type AgentErrorCode =
  | 'ERR_TOOL_NOT_FOUND'
  | 'ERR_INVALID_ARGUMENTS'
  | 'ERR_PRECONDITION_FAILED'
  | 'ERR_EXECUTION_TIMEOUT'
  | 'ERR_NETWORK_PROVIDER'
  | 'ERR_TRACK_NOT_FOUND'
  | 'ERR_READ_ONLY_LOCK'
  | 'ERR_ABORTED_BY_USER'
  | 'ERR_PIPELINE_ROLLEDBACK'

export interface AgentStepResult {
  step: number
  stepId?: string
  tool: AgentToolName | string
  status?: StepExecutionStatus
  success: boolean
  message: string
  explanation?: string
  data?: any
  errorCode?: AgentErrorCode
  durationMs?: number
}

export interface AgentPipelineResult {
  pipelineId?: string
  success: boolean
  executed: number
  total: number
  completedSteps: number
  totalSteps: number
  stepResults: AgentStepResult[]
  snapshotId?: string
  rolledBack?: boolean
  message: string
  summaryMessage?: string
}
