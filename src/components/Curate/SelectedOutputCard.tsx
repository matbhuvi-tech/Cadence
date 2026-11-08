import React from 'react'

interface SelectedOutputCardProps {
  albumCount: number
  trackCount: number
  canAcceptSuggestions?: boolean
  onAcceptSuggestions?: () => void
}

export function SelectedOutputCard({
  albumCount, trackCount, canAcceptSuggestions = false, onAcceptSuggestions,
}: SelectedOutputCardProps) {
  return (
    <section aria-label="Selected Output" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
      <div>
        <h3 className="text-xs font-semibold text-emerald-400">Selected Output</h3>
        <p data-testid="curate-change-summary" className="mt-0.5 text-xs text-zinc-300" aria-live="polite">
          {albumCount || trackCount
            ? `${albumCount} album ${albumCount === 1 ? 'field' : 'fields'} · ${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} changed`
            : 'No changes from local tags'}
        </p>
      </div>
      {onAcceptSuggestions && (
        <button
          type="button"
          disabled={!canAcceptSuggestions}
          onClick={onAcceptSuggestions}
          className="rounded-md border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          Accept Suggestions
        </button>
      )}
    </section>
  )
}
