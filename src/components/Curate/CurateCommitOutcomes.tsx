import type { CurateCommitRow } from '../../core/curateCommit'

const labels = { completed: 'Complete', pending: 'Waiting', in_flight: 'Writing', failed: 'Failed' }

export function CurateCommitOutcomes({ tracks, rows }: {
  tracks: { trackId: string; localTitle: string }[]
  rows: CurateCommitRow[]
}) {
  const byTrack = new Map(rows.map(row => [row.trackId, row]))
  const outcomes = tracks.map(track => ({ track, row: byTrack.get(track.trackId) }))
  if (!outcomes.some(({ row }) => row)) return null
  const counts = { completed: 0, pending: 0, in_flight: 0, failed: 0, missing: 0 }
  for (const { row } of outcomes) counts[row?.status ?? 'missing']++
  const summary = [
    counts.completed && `${counts.completed} complete`,
    counts.pending && `${counts.pending} waiting`,
    counts.in_flight && `${counts.in_flight} writing`,
    counts.failed && `${counts.failed} failed`,
    counts.missing && `${counts.missing} without a current commit`,
  ].filter(Boolean).join(' · ')

  return (
    <details className="mx-4 rounded-lg border border-white/10 bg-white/[0.02] text-xs">
      <summary className="cursor-pointer px-3 py-2 text-white/70">Track write outcomes · {summary}</summary>
      <p className="px-3 pb-2 text-white/45">Latest confirmed intent for each track. Later draft edits are not included.</p>
      <ul aria-label="Track write outcomes" className="max-h-64 overflow-y-auto divide-y divide-white/5">
        {outcomes.map(({ track, row }, index) => (
          <li key={track.trackId} className="px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words text-white/75">{index + 1}. {track.localTitle || track.trackId}</span>
              <span className={`shrink-0 ${row?.status === 'failed' ? 'text-amber-200' : 'text-cyan-300'}`}>
                {row ? labels[row.status] : 'No current commit'}
              </span>
            </div>
            {row?.status === 'failed' && <p className="mt-1 break-words text-amber-200">{row.errorMessage || 'Write failed. Retry this track using Retry failed tracks.'}</p>}
          </li>
        ))}
      </ul>
    </details>
  )
}
