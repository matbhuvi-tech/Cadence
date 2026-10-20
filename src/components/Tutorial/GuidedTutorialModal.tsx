import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Compass,
  ChevronLeft,
  ChevronRight,
  X,
  Play,
  Pause,
  Code2,
  BookOpen,
  Layers,
  Sparkles,
  ExternalLink,
  Copy,
  Check,
  Zap,
} from 'lucide-react'
import { TUTORIAL_STEPS, TutorialStep, TutorialActions } from '../../tutorial/tutorialSteps'

interface GuidedTutorialModalProps {
  isOpen: boolean
  onClose: () => void
  actions: TutorialActions
}

export const GuidedTutorialModal: React.FC<GuidedTutorialModalProps> = ({
  isOpen,
  onClose,
  actions,
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'human' | 'agent'>('human')
  const [isPlaying, setIsPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState<number>(4000) // ms per step
  const [copiedDoc, setCopiedDoc] = useState(false)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)

  const step = TUTORIAL_STEPS[currentStepIndex] || TUTORIAL_STEPS[0]
  const cardRef = useRef<HTMLDivElement>(null)

  // Execute step context transition (switching view mode, tab, modal, etc.)
  useEffect(() => {
    if (!isOpen || !step) return

    if (step.contextTransition) {
      step.contextTransition(actions)
    }

    // Allow DOM to settle before measuring target geometry
    const timer = setTimeout(() => {
      measureTarget()
    }, 120)

    return () => clearTimeout(timer)
  }, [currentStepIndex, isOpen, step])

  // Measure target DOM element bounding box and scroll into view
  const measureTarget = () => {
    if (!step) return
    const el = document.querySelector(step.targetSelector)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
      const rect = el.getBoundingClientRect()
      setTargetRect(rect)
    } else {
      setTargetRect(null)
    }
  }

  // Window resize & scroll listener to keep spotlight pinned
  useEffect(() => {
    if (!isOpen) return
    const handleUpdate = () => measureTarget()
    window.addEventListener('resize', handleUpdate)
    window.addEventListener('scroll', handleUpdate, true)
    return () => {
      window.removeEventListener('resize', handleUpdate)
      window.removeEventListener('scroll', handleUpdate, true)
    }
  }, [isOpen, currentStepIndex])

  // Auto-Tour player timer
  useEffect(() => {
    if (!isOpen || !isPlaying) return
    const interval = setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev < TUTORIAL_STEPS.length - 1) {
          return prev + 1
        } else {
          setIsPlaying(false)
          return prev
        }
      })
    }, playSpeed)
    return () => clearInterval(interval)
  }, [isOpen, isPlaying, playSpeed])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        goToNext()
      } else if (e.key === 'ArrowLeft') {
        goToPrev()
      } else if (e.key === 'Escape') {
        onClose()
      } else if (e.key === ' ') {
        e.preventDefault()
        setIsPlaying((p) => !p)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, currentStepIndex])

  // Expose global Headless Agent interface on window.__CADENCE_TUTORIAL__
  useEffect(() => {
    if (typeof window === 'undefined') return

    const agentBridge = {
      isActive: isOpen,
      currentStepIndex,
      currentStep: step,
      totalSteps: TUTORIAL_STEPS.length,
      getAllSteps: () => TUTORIAL_STEPS,
      getCurrentStep: () => step,
      goToStep: (indexOrId: number | string) => {
        if (typeof indexOrId === 'number') {
          if (indexOrId >= 0 && indexOrId < TUTORIAL_STEPS.length) {
            setCurrentStepIndex(indexOrId)
          }
        } else {
          const idx = TUTORIAL_STEPS.findIndex((s) => s.id === indexOrId)
          if (idx !== -1) setCurrentStepIndex(idx)
        }
      },
      next: () => goToNext(),
      prev: () => goToPrev(),
      play: () => setIsPlaying(true),
      pause: () => setIsPlaying(false),
      stop: () => onClose(),
      exportDocumentation: (format: 'json' | 'markdown' = 'json') => {
        if (format === 'markdown') {
          return TUTORIAL_STEPS.map(
            (s, i) =>
              `### ${i + 1}. ${s.title} (${s.categoryLabel})\n- **Role**: ${s.role}\n- **Selector**: \`${s.targetSelector}\`\n- **Explanation**: ${s.humanExplanation}\n- **Agent Protocol**: \`${JSON.stringify(s.agentProtocol)}\`\n`
          ).join('\n---\n\n')
        }
        return JSON.stringify(TUTORIAL_STEPS, null, 2)
      },
    }

    ;(window as any).__CADENCE_TUTORIAL__ = agentBridge
    if (isOpen) {
      document.body.setAttribute('data-cadence-tutorial-active', 'true')
      document.body.setAttribute('data-cadence-active-step', step?.id || '')
    } else {
      document.body.removeAttribute('data-cadence-tutorial-active')
      document.body.removeAttribute('data-cadence-active-step')
    }

    return () => {
      document.body.removeAttribute('data-cadence-tutorial-active')
      document.body.removeAttribute('data-cadence-active-step')
    }
  }, [isOpen, currentStepIndex, step])

  const goToNext = () => {
    if (currentStepIndex < TUTORIAL_STEPS.length - 1) {
      setCurrentStepIndex((i) => i + 1)
    }
  }

  const goToPrev = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((i) => i - 1)
    }
  }

  const handleCopyAgentDocumentation = () => {
    const doc = (window as any).__CADENCE_TUTORIAL__?.exportDocumentation('markdown')
    if (doc) {
      navigator.clipboard.writeText(doc)
      setCopiedDoc(true)
      setTimeout(() => setCopiedDoc(false), 2500)
    }
  }

  // Calculate card position relative to target or viewport center
  const cardStyle = useMemo<React.CSSProperties>(() => {
    if (!targetRect) {
      return {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 100,
      }
    }

    const margin = 16
    const cardWidth = 480
    const cardHeight = 360
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = targetRect.bottom + margin
    let left = targetRect.left

    // If bottom clips viewport, flip to top
    if (top + cardHeight > vh - 20) {
      top = Math.max(20, targetRect.top - cardHeight - margin)
    }

    // Keep horizontally in viewport
    if (left + cardWidth > vw - 20) {
      left = Math.max(20, vw - cardWidth - 20)
    }
    if (left < 20) left = 20

    return {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      zIndex: 100,
    }
  }, [targetRect])

  if (!isOpen || !step) return null

  return (
    <div className="fixed inset-0 z-50 pointer-events-none select-none font-sans">
      {/* 1. Translucent Backdrop Overlay with Spotlight Cutout */}
      <div className="absolute inset-0 bg-black/70 transition-opacity duration-300 pointer-events-auto" />

      {/* 2. Spotlight Ring & Pulse Highlighter around target element */}
      {targetRect && (
        <div
          className="fixed pointer-events-none transition-all duration-300 ease-out z-[90] rounded-xl ring-4 ring-[#00F5FF] shadow-[0_0_35px_rgba(0,245,255,0.6)] animate-pulse"
          style={{
            top: `${Math.max(0, targetRect.top - 6)}px`,
            left: `${Math.max(0, targetRect.left - 6)}px`,
            width: `${targetRect.width + 12}px`,
            height: `${targetRect.height + 12}px`,
          }}
        >
          {/* Neon Corner Accents */}
          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 border-t-2 border-l-2 border-[#ADFF2F]" />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 border-t-2 border-r-2 border-[#ADFF2F]" />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 border-b-2 border-l-2 border-[#ADFF2F]" />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 border-b-2 border-r-2 border-[#ADFF2F]" />
        </div>
      )}

      {/* 3. Floating Interactive Guide Dialog */}
      <div
        ref={cardRef}
        style={cardStyle}
        className="pointer-events-auto w-[490px] bg-[#12151E]/95 border border-[#00F5FF]/40 rounded-2xl shadow-2xl backdrop-blur-2xl overflow-hidden flex flex-col glow-cyan animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Progress Bar */}
        <div className="h-1 w-full bg-white/[0.08] overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#00F5FF] via-[#ADFF2F] to-[#8B5CF6] transition-all duration-300"
            style={{
              width: `${((currentStepIndex + 1) / TUTORIAL_STEPS.length) * 100}%`,
            }}
          />
        </div>

        {/* Dialog Header */}
        <div className="p-4 px-5 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00F5FF] to-[#ADFF2F] flex items-center justify-center text-black font-extrabold shadow-sm">
              <Compass className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono tracking-widest text-[#00F5FF] uppercase font-bold">
                  {step.categoryLabel}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#94A3B8] font-mono">
                  {currentStepIndex + 1} / {TUTORIAL_STEPS.length}
                </span>
              </div>
              <h3 className="text-sm font-bold text-[#F1F5F9] tracking-tight">{step.title}</h3>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* View Mode Toggle: Human vs Agent */}
            <div className="flex items-center p-0.5 bg-black/40 rounded-lg border border-white/[0.08]">
              <button
                onClick={() => setViewMode('human')}
                title="Human Guide: Visual Walkthrough & Rationale"
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-all ${
                  viewMode === 'human'
                    ? 'bg-[#00F5FF]/20 text-[#00F5FF] font-bold'
                    : 'text-[#64748B] hover:text-white'
                }`}
              >
                <BookOpen className="w-3 h-3" />
                <span>Guide</span>
              </button>
              <button
                onClick={() => setViewMode('agent')}
                title="Headless Agent Protocol: Selectors, Events & State Mutations"
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-all ${
                  viewMode === 'agent'
                    ? 'bg-[#ADFF2F]/20 text-[#ADFF2F] font-bold'
                    : 'text-[#64748B] hover:text-white'
                }`}
              >
                <Code2 className="w-3 h-3" />
                <span>Agent JSON</span>
              </button>
            </div>

            <button
              onClick={onClose}
              title="Close Tutorial (Esc)"
              className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Dialog Content Area */}
        <div className="p-5 overflow-y-auto max-h-[300px] text-left text-xs leading-relaxed">
          {viewMode === 'human' ? (
            <div className="flex flex-col gap-3">
              {/* Role Summary */}
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[#CBD5E1] font-medium flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-[#ADFF2F] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-white">Functional Purpose: </span>
                  {step.role}
                </div>
              </div>

              {/* In-Depth Human Explanation */}
              <div className="text-[#94A3B8] leading-relaxed whitespace-pre-line">
                {step.humanExplanation}
              </div>

              {/* Target & Shortcut Pill */}
              <div className="flex items-center justify-between text-[10px] font-mono pt-2 border-t border-white/[0.06]">
                <div className="flex items-center gap-1 text-[#64748B]">
                  <span>Selector:</span>
                  <code className="text-[#00F5FF] bg-black/40 px-1.5 py-0.5 rounded">
                    {step.targetSelector}
                  </code>
                </div>
                {step.agentProtocol.keyboardShortcut && (
                  <div className="flex items-center gap-1 text-[#64748B]">
                    <span>Shortcut:</span>
                    <span className="text-[#ADFF2F] font-bold bg-[#ADFF2F]/10 border border-[#ADFF2F]/30 px-1.5 py-0.5 rounded">
                      {step.agentProtocol.keyboardShortcut}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-[#ADFF2F] font-semibold">
                  AGENT EXECUTION PROTOCOL
                </span>
                <button
                  onClick={handleCopyAgentDocumentation}
                  className="flex items-center gap-1 text-[10px] font-mono text-[#64748B] hover:text-white transition-colors"
                >
                  {copiedDoc ? <Check className="w-3 h-3 text-[#10B981]" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedDoc ? 'Copied Full Doc' : 'Copy Full Spec'}</span>
                </button>
              </div>

              <pre className="p-3 rounded-xl bg-black/60 border border-white/[0.08] text-[11px] font-mono text-[#00F5FF] overflow-x-auto leading-normal">
                {JSON.stringify(
                  {
                    stepId: step.id,
                    title: step.title,
                    category: step.category,
                    targetSelector: step.targetSelector,
                    interactionType: step.agentProtocol.interactionType,
                    apiEndpoints: step.agentProtocol.apiEndpoints,
                    dataModelMutation: step.agentProtocol.dataModelMutation,
                    shortcut: step.agentProtocol.keyboardShortcut || null,
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          )}
        </div>

        {/* Dialog Footer Navigation */}
        <div className="p-3 px-5 border-t border-white/[0.08] bg-white/[0.01] flex items-center justify-between">
          {/* Left: Step Dropdown Picker */}
          <select
            value={currentStepIndex}
            onChange={(e) => setCurrentStepIndex(Number(e.target.value))}
            className="bg-black/60 border border-white/[0.1] rounded-lg text-[11px] font-mono text-[#94A3B8] px-2 py-1 focus:outline-none focus:border-[#00F5FF] max-w-[180px] cursor-pointer"
          >
            {TUTORIAL_STEPS.map((s, idx) => (
              <option key={s.id} value={idx}>
                {idx + 1}. {s.title}
              </option>
            ))}
          </select>

          {/* Center: Play/Pause Auto-Tour */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsPlaying((p) => !p)}
              title={isPlaying ? 'Pause Auto-Tour (Space)' : 'Play Auto-Tour through all steps (Space)'}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-all ${
                isPlaying
                  ? 'bg-[#ADFF2F]/20 text-[#ADFF2F] border border-[#ADFF2F]/40 font-bold'
                  : 'bg-white/[0.04] text-[#94A3B8] hover:text-white border border-white/[0.08]'
              }`}
            >
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{isPlaying ? 'Playing' : 'Auto-Tour'}</span>
            </button>
          </div>

          {/* Right: Prev / Next Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={goToPrev}
              disabled={currentStepIndex === 0}
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 disabled:cursor-not-allowed text-[#CBD5E1] text-xs font-mono transition-all flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>

            <button
              onClick={goToNext}
              disabled={currentStepIndex === TUTORIAL_STEPS.length - 1}
              className="px-3.5 py-1 rounded-lg bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-semibold text-xs transition-all flex items-center gap-1 shadow-sm disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span>{currentStepIndex === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next'}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
