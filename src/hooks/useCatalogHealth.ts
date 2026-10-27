import { useMemo, useState, useEffect, useRef } from 'react'
import { Track, Release } from '../core/types'
import { auditService, AuditEvaluationResult } from '../services/auditService'

export interface CatalogHealthState {
  globalHealthScore: number
  scopedHealthScore: number
  impactedAlbumsCount: number
  totalActionableTracks: number
  isCatalogPristine: boolean
  statusMessage: string
  evaluation: AuditEvaluationResult
}

const DEFAULT_EVALUATION: AuditEvaluationResult = {
  issues: [],
  healthScore: 100,
  deductions: [],
  totalTracks: 0,
  cleanTracks: 0,
}

/**
 * Shared authoritative hook for catalog health diagnostics.
 * Adheres strictly to Audiophile Invariants:
 * - Debounces calculations (500ms).
 * - Suspends recalculation while audio playback is active or paused (Audiophile Invariant 1).
 * - Memoizes results against track collection size and version counter.
 */
export function useCatalogHealth(
  tracks: Track[],
  releases: Release[],
  isAudioActive: boolean = false
): CatalogHealthState {
  const [evaluation, setEvaluation] = useState<AuditEvaluationResult>(() => {
    return auditService.computeCatalogAudit(tracks, releases)
  })

  // Track version signature: length + sum of modification timestamps (sample)
  const trackVersionSignature = useMemo(() => {
    if (!tracks || tracks.length === 0) return '0'
    const len = tracks.length
    const sample = tracks[0]?.id || ''
    const tail = tracks[tracks.length - 1]?.id || ''
    return `${len}:${sample}:${tail}:${releases.length}`
  }, [tracks, releases])

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // Audiophile Transport Guard: Skip recalculations during active audio playback or pause
    if (isAudioActive) {
      return
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(() => {
      const res = auditService.computeCatalogAudit(tracks, releases)
      setEvaluation(res)
    }, 500)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [trackVersionSignature, isAudioActive, tracks, releases])

  return useMemo(() => {
    const healthScore = evaluation.healthScore
    const totalIssues = evaluation.issues.length

    // Extract unique impacted albums and total actionable tracks from issues
    const impactedAlbumIds = new Set<string>()
    let actionableTracksCount = 0

    for (const issue of evaluation.issues) {
      actionableTracksCount += issue.affectedCount || issue.sampleTrackIds?.length || 0
      const relId = (issue as any).affectedReleaseId || (issue as any).releaseId
      if (relId) {
        impactedAlbumIds.add(relId)
      }
    }

    const impactedAlbumsCount = impactedAlbumIds.size
    const isCatalogPristine = totalIssues === 0 || healthScore === 100

    let statusMessage: string
    if (isCatalogPristine) {
      statusMessage = 'All albums and tracks conform to bit-perfect metadata standards.'
    } else {
      statusMessage = `${actionableTracksCount} tracks across ${impactedAlbumsCount > 0 ? impactedAlbumsCount : 'multiple'} albums require metadata or artwork triage.`
    }

    return {
      globalHealthScore: healthScore,
      scopedHealthScore: healthScore,
      impactedAlbumsCount,
      totalActionableTracks: actionableTracksCount,
      isCatalogPristine,
      statusMessage,
      evaluation,
    }
  }, [evaluation])
}
