import React, { useEffect, useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ambientCurationService,
  AmbientCurationState,
} from '../../services/ambientCurationService'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { Lock, Pause, Play, Sparkles, Check, Clock, CheckCircle2 } from 'lucide-react'

interface AmbientCurationCapsuleProps {
  onStopPlayback?: () => Promise<void> | void
}

export const AmbientCurationCapsule: React.FC<AmbientCurationCapsuleProps> = ({
  onStopPlayback,
}) => {
  const { stop } = useAudioPlayer()
  const [curationState, setCurationState] = useState<AmbientCurationState>(
    ambientCurationService.getState()
  )
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverCoords, setPopoverCoords] = useState<{ left: number; bottom: number } | null>(null)

  useEffect(() => {
    const unsubscribe = ambientCurationService.subscribe((newState) => {
      setCurationState(newState)
      if (newState.state === 'complete' && newState.total > 0) {
        setShowComplete(true)
        const timer = setTimeout(() => {
          setShowComplete(false)
        }, 5000)
        return () => clearTimeout(timer)
      } else {
        setShowComplete(false)
      }
    })
    return () => unsubscribe()
  }, [])

  // Dynamic positioning for portal popover
  const updateCoords = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      // Position above the capsule button, horizontally clamped within viewport
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - 340))
      const bottom = Math.max(12, window.innerHeight - rect.top + 8)
      setPopoverCoords({ left, bottom })
    }
  }

  useLayoutEffect(() => {
    if (popoverOpen) {
      updateCoords()
      window.addEventListener('resize', updateCoords)
      window.addEventListener('scroll', updateCoords, true)
      return () => {
        window.removeEventListener('resize', updateCoords)
        window.removeEventListener('scroll', updateCoords, true)
      }
    }
  }, [popoverOpen])

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setPopoverOpen(false)
      }
    }
    if (popoverOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [popoverOpen])

  const {
    state,
    completed,
    total,
    pending,
    cooldownRemainingSecs,
    currentArtistName,
    lastResolved,
    nextInQueue,
  } = curationState

  // Apple HIG Deference: If complete and grace period has elapsed, render nothing
  if (state === 'complete' && !showComplete && !popoverOpen) {
    return null
  }

  // Percentage progress
  const progressPercent =
    total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100

  return (
    <div className="relative w-full pt-1">
      {/* 1. Ambient Status Capsule Button */}
      <button
        ref={buttonRef}
        onClick={() => setPopoverOpen((prev) => !prev)}
        className="w-full text-left px-2 py-1.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer flex items-center justify-between group"
        title="Hardware Telemetry: Click to view background curation details"
      >
        <div className="flex items-center gap-2 truncate">
          {/* LED Indicator Dot */}
          {state === 'active' && (
            <span
              className="w-2 h-2 rounded-full shrink-0 animate-pulse"
              style={{
                backgroundColor: '#D4AF37',
                boxShadow: '0 0 6px rgba(212, 175, 55, 0.7)',
              }}
            />
          )}

          {state === 'cooldown' && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                backgroundColor: '#F59E0B',
                boxShadow: '0 0 5px rgba(245, 158, 11, 0.6)',
              }}
            />
          )}

          {state === 'paused_playback' && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                backgroundColor: '#10B981',
                boxShadow: '0 0 6px rgba(16, 185, 129, 0.6)',
              }}
            />
          )}

          {state === 'user_paused' && (
            <span className="w-2 h-2 rounded-full shrink-0 bg-[#8E8E93]" />
          )}

          {state === 'complete' && (
            <Check className="w-2.5 h-2.5 text-[#10B981] shrink-0" />
          )}

          {/* Monospace 11px Typography: Concise labels that never overflow the rail */}
          <span className="text-[11px] font-mono tabular-nums text-[#8E8E93] group-hover:text-[#F5F5F7] truncate transition-colors">
            {state === 'active' && (
              <>
                <span className="text-[#D4AF37]">◎</span> Ingesting Portraits…
              </>
            )}

            {state === 'cooldown' && (
              <>
                <span className="text-amber-400">⏳</span> Settling ({cooldownRemainingSecs ?? 30}s)
              </>
            )}

            {state === 'paused_playback' && (
              <>
                <span className="text-emerald-400">🔒</span> Purity Lock Active
              </>
            )}

            {state === 'user_paused' && (
              <>
                <span>⏸</span> Sync Paused
              </>
            )}

            {state === 'complete' && (
              <span className="text-emerald-400 transition-opacity duration-1000">
                ✓ Portraits Complete
              </span>
            )}
          </span>
        </div>

        {/* Small subtle status percentage / count indicator */}
        <span className="text-[10px] font-mono text-[#636366] group-hover:text-[#8E8E93] shrink-0 ml-1">
          {total > 0 && state !== 'complete' ? `${progressPercent}%` : (total > 0 ? `${total}` : '')}
        </span>
      </button>

      {/* 2. Interactive Activity Popover via React Portal to prevent container overflow truncation */}
      {popoverOpen && popoverCoords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              left: `${popoverCoords.left}px`,
              bottom: `${popoverCoords.bottom}px`,
              width: '320px',
              zIndex: 9999,
            }}
            className="rounded-xl backdrop-blur-2xl bg-[#1C1C1E]/95 border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.8)] p-4 text-xs font-sans text-[#F5F5F7] animate-in fade-in zoom-in-95 duration-150 select-none"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#D4AF37]">
                  Background Curation
                </span>
              </div>
              {state !== 'complete' && (
                <button
                  onClick={() => ambientCurationService.togglePause()}
                  className="px-2 py-0.5 rounded text-[10px] font-mono bg-white/[0.06] hover:bg-white/[0.12] text-[#8E8E93] hover:text-white transition-all cursor-pointer flex items-center gap-1"
                >
                  {state === 'user_paused' ? (
                    <>
                      <Play className="w-2.5 h-2.5 text-emerald-400" />
                      <span>Resume</span>
                    </>
                  ) : (
                    <>
                      <Pause className="w-2.5 h-2.5 text-amber-400" />
                      <span>Pause Sync</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Status Explanation */}
            <div className="py-2.5 space-y-1">
              <div className="flex items-center gap-2">
                {state === 'paused_playback' && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                )}
                {state === 'cooldown' && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 animate-ping" />
                )}
                {state === 'active' && (
                  <span className="w-2 h-2 rounded-full bg-[#D4AF37] shrink-0 animate-pulse" />
                )}
                {state === 'complete' && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                )}
                {state === 'user_paused' && (
                  <span className="w-2 h-2 rounded-full bg-[#8E8E93] shrink-0" />
                )}

                <span className="font-medium text-[11px] text-[#F5F5F7] leading-tight">
                  {state === 'paused_playback' &&
                    'Suspended — Transport Purity Lock Active'}
                  {state === 'cooldown' &&
                    `Bus Settling · ${cooldownRemainingSecs ?? 30}s Cooldown Gate`}
                  {state === 'active' &&
                    `Active Enrichment · Ingesting Portraits`}
                  {state === 'user_paused' && 'Sync Manually Suspended'}
                  {state === 'complete' && 'All Artist Portraits Synchronized'}
                </span>
              </div>

              <p className="text-[10px] font-mono text-[#8E8E93] leading-relaxed pl-4 break-words">
                {state === 'paused_playback' &&
                  'Network & disk writes are strictly blocked during audio playback to protect DAC clock jitter.'}
                {state === 'cooldown' &&
                  'Waiting 30 seconds after transport stop for NVMe/SATA controller power states to settle.'}
                {state === 'active' &&
                  `Currently querying federated portrait endpoints for ${currentArtistName || 'queued artist'}.`}
                {state === 'user_paused' &&
                  'Background portrait enrichment is currently paused by user request.'}
                {state === 'complete' &&
                  'All canonical library artists have high-resolution portraits or verified negative caches.'}
              </p>
            </div>

            {/* Progress Bar */}
            <div className="py-2 space-y-1.5 border-t border-white/[0.06]">
              <div className="flex items-center justify-between text-[10px] font-mono text-[#8E8E93]">
                <span>Progress:</span>
                <span className="text-[#F5F5F7] font-semibold">
                  {completed} of {total} Artists ({progressPercent}%{pending > 0 ? ` · ${pending} pending` : ''})
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-500/80 to-[#D4AF37] transition-all duration-500 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Telemetry Details: Last Resolved & Next in Queue */}
            {(lastResolved || nextInQueue.length > 0) && (
              <div className="py-2 border-t border-white/[0.06] space-y-1.5 text-[10px] font-mono">
                {lastResolved && (
                  <div className="flex items-start gap-1.5 text-[#8E8E93]">
                    <span className="text-[#636366] shrink-0">Last Resolved:</span>
                    <span className="text-[#F5F5F7] truncate">
                      {lastResolved.artistName}{' '}
                      <span className="text-[#8E8E93]">({lastResolved.provider})</span>
                    </span>
                  </div>
                )}

                {nextInQueue.length > 0 && (
                  <div className="flex items-start gap-1.5 text-[#8E8E93]">
                    <span className="text-[#636366] shrink-0">Next in Queue:</span>
                    <span className="text-[#F5F5F7] truncate">
                      {nextInQueue.slice(0, 3).join(', ')}
                      {nextInQueue.length > 3 ? '…' : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Direct Action Button or Complete Banner */}
            {state === 'paused_playback' && pending > 0 && (
              <div className="pt-2 border-t border-white/[0.06]">
                <button
                  onClick={async () => {
                    await ambientCurationService.enrichRemainingNow(onStopPlayback || stop)
                    setPopoverOpen(false)
                  }}
                  className="w-full py-1.5 px-3 rounded-lg bg-[#D4AF37]/15 hover:bg-[#D4AF37]/25 border border-[#D4AF37]/30 text-[#D4AF37] text-[10px] font-mono font-medium transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.99]"
                >
                  <Lock className="w-3 h-3" />
                  <span>Enrich Remaining Now (Stops Playback)</span>
                </button>
              </div>
            )}

            {state === 'complete' && (
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-center gap-1.5 text-[10px] font-mono text-emerald-400/90">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Library Curated · Bit-Perfect Purity Intact</span>
              </div>
            )}

            {state === 'cooldown' && (
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-center gap-1.5 text-[10px] font-mono text-amber-400/80">
                <Clock className="w-3 h-3 animate-spin" />
                <span>Auto-resumes in {cooldownRemainingSecs ?? 30} seconds</span>
              </div>
            )}
          </div>,
          document.body
        )
      }
    </div>
  )
}
