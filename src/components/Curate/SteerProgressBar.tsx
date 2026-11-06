import React from 'react'
import type { OutcomeStatus } from '../../core/types'

interface SteerProgressBarProps {
  phase: string
  message: string
  outcomeStatus?: OutcomeStatus | null
  isFetching: boolean
  evidenceSaveFailed?: boolean
  onToggleRationale?: () => void
  hasTrace?: boolean
}

export const SteerProgressBar: React.FC<SteerProgressBarProps> = ({
  message,
  outcomeStatus,
  isFetching,
  evidenceSaveFailed,
  onToggleRationale,
  hasTrace
}) => {
  if (!isFetching && !outcomeStatus && !hasTrace && !evidenceSaveFailed) {
    return null
  }

  // Active fetch stage feedback
  if (isFetching) {
    return (
      <div 
        className="flex items-center gap-2 px-2.5 py-1 rounded bg-zinc-900/90 border border-cyan-500/30 text-xs font-mono text-cyan-400 select-none max-w-[280px] h-[26px] overflow-hidden"
        title={message || 'Processing curation intelligence...'}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        <span className="truncate">{message || 'Curating candidate metadata...'}</span>
      </div>
    )
  }

  // Completed outcome badge with click to inspect
  let badgeColor = 'bg-zinc-800 text-zinc-300 border-zinc-700'
  let label = 'Evidence history'

  if (outcomeStatus === 'matched_applied') {
    badgeColor = 'bg-emerald-950/80 text-emerald-400 border-emerald-700/50 hover:bg-emerald-900/80'
    label = 'Matched & Applied'
  } else if (outcomeStatus === 'evaluated_unchanged') {
    badgeColor = 'bg-zinc-800/80 text-zinc-300 border-zinc-700/60 hover:bg-zinc-700/80'
    label = 'Evaluated, Unchanged'
  } else if (outcomeStatus === 'incomplete') {
    badgeColor = 'bg-amber-950/80 text-amber-400 border-amber-700/50 hover:bg-amber-900/80'
    label = 'Incomplete'
  } else if (outcomeStatus === 'paused_playback') {
    badgeColor = 'bg-amber-950/80 text-amber-400 border-amber-700/50 hover:bg-amber-900/80'
    label = 'Paused for Playback'
  } else if (outcomeStatus === 'failed') {
    badgeColor = 'bg-red-950/80 text-red-400 border-red-700/50 hover:bg-red-900/80'
    label = 'Evaluation Failed'
  }
  if (evidenceSaveFailed) {
    badgeColor = 'bg-red-950/80 text-red-400 border-red-700/50 hover:bg-red-900/80'
    label = 'Evidence Save Failed'
  }

  return (
    <div className="flex items-center gap-1.5 select-none h-[26px]">
      <button
        type="button"
        onClick={onToggleRationale}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-mono font-medium transition-colors shadow-sm cursor-pointer ${badgeColor}`}
        title={evidenceSaveFailed ? message : 'Click or press Ctrl+I to inspect curation decision rationale and evidence'}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
        <span>{label}</span>
        <span className="text-[10px] opacity-60 ml-0.5">Ctrl+I</span>
      </button>
    </div>
  )
}

