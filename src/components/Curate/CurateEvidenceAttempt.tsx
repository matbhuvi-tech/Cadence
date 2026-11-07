import type { CurateProviderAttempt } from '../../services/curateEvidenceService'

export function CurateEvidenceAttempt({ attempt }: { attempt: CurateProviderAttempt }) {
  const provider = attempt.provider === 'gemini' ? 'Gemini AI'
    : attempt.provider === 'apple' ? 'Apple' : 'MusicBrainz'
  const candidate = attempt.candidate
  return (
    <div className="space-y-1 text-zinc-300">
      <div className="flex flex-wrap justify-between gap-1">
        <span>{provider} · {attempt.outcome.replaceAll('_', ' ')}</span>
        <span>{attempt.durationMs} ms{attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ''}</span>
      </div>
      {attempt.errorMessage && <p className="break-words text-amber-300">{attempt.errorMessage}</p>}
      {attempt.modelUsed && <p className="text-zinc-400">Model {attempt.modelUsed}</p>}
      {(attempt.pacingDelayMs !== undefined || attempt.retriesAttempted !== undefined) && (
        <p className="text-zinc-400">
          {attempt.pacingDelayMs !== undefined && `Waited ${attempt.pacingDelayMs} ms`}
          {attempt.pacingDelayMs !== undefined && attempt.retriesAttempted !== undefined && ' · '}
          {attempt.retriesAttempted !== undefined && `${attempt.retriesAttempted} retries`}
        </p>
      )}
      {candidate && (
        <>
          <p className="text-zinc-400">
            {attempt.provider === 'gemini' && 'Album context · '}
            {[candidate.title, candidate.artist, candidate.year].filter(Boolean).join(' · ')}
            {candidate.trackCount !== undefined ? ` · ${candidate.trackCount} tracks` : ''}
          </p>
          {candidate.tracks && candidate.tracks.length > 0 && (
            <details>
              <summary className="cursor-pointer">Returned track details</summary>
              <ol className="mt-2 space-y-3 border-l border-zinc-700 pl-3">
                {candidate.tracks.map((track, index) => (
                  <li key={index} className="space-y-1 break-words">
                    <p className="font-medium text-zinc-200">{track.number ?? index + 1} · {track.title || 'Untitled track'}</p>
                    {track.localTrackId && <p className="text-zinc-500">Local track {track.localTrackId}</p>}
                    {track.artist && <p>{attempt.provider === 'gemini' ? 'Singers' : 'Artist'} · {track.artist}</p>}
                    {track.composer && <p>Composer · {track.composer}</p>}
                    {(track.originalAlbum || track.originalYear) && (
                      <p>Original release · {[track.originalAlbum, track.originalYear].filter(Boolean).join(' · ')}</p>
                    )}
                    {track.isCompilationTrack !== undefined && (
                      <p>{track.isCompilationTrack ? 'From a different original release' : 'Native album track'}</p>
                    )}
                    {track.confidence !== undefined && <p>Confidence · {Math.round(track.confidence * 100)}%</p>}
                    {track.notes && <p className="text-zinc-400">{track.notes}</p>}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </div>
  )
}
