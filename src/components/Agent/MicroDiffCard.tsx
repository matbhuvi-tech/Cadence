import React, { useState } from 'react'
import {
  RotateCcw,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  Layers,
  Sparkles,
} from 'lucide-react'
import { AgentActionCommand, AgentDispatcherContext } from '../../services/agentActionDispatcher'
import { agentPipelineEngine } from '../../services/agentPipelineEngine'

export interface MutationDiffPreview {
  field: string
  before: string
  after: string
  count: number
  sampleEntities?: string[]
}

interface MicroDiffCardProps {
  command: AgentActionCommand
  commandResult: { success: boolean; message: string; data?: any }
  dispatcherContext: AgentDispatcherContext
  checkpointId?: string
  diffPreview?: MutationDiffPreview[]
  onUndoSuccess?: (message: string) => void
}

export const MicroDiffCard: React.FC<MicroDiffCardProps> = ({
  command,
  commandResult,
  dispatcherContext,
  checkpointId,
  diffPreview,
  onUndoSuccess,
}) => {
  const [isUndone, setIsUndone] = useState(false)
  const [undoMessage, setUndoMessage] = useState<string | null>(null)

  const handleUndo = () => {
    if (isUndone) return
    const res = checkpointId
      ? agentPipelineEngine.restoreCheckpoint(checkpointId)
        ? { success: true, message: 'Restored prior state from checkpoint.' }
        : { success: false, message: 'Checkpoint not found.' }
      : agentPipelineEngine.undoLastPipeline(dispatcherContext)

    if (res.success) {
      dispatcherContext.refreshFromEngine()
      dispatcherContext.showToast(res.message)
      setIsUndone(true)
      setUndoMessage(res.message)
      onUndoSuccess?.(res.message)
    } else {
      dispatcherContext.showToast(`Undo failed: ${res.message}`)
    }
  }

  const isMutatingCommand =
    command.tool === 'remediate_issue' ||
    command.tool === 'rework_backdrop' ||
    command.tool === 'stage_metadata' ||
    (command.tool === 'execute_pipeline' &&
      command.args?.commands?.some(
        (c: any) =>
          c.tool === 'remediate_issue' ||
          c.tool === 'rework_backdrop' ||
          c.tool === 'stage_metadata'
      ))

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-black/50 border border-white/[0.09] shadow-lg flex flex-col gap-2.5 text-xs select-none">
      {/* 1. Header with Status Pill and Tool Explanation */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[#00F5FF] truncate">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          <span className="font-mono font-medium truncate">
            {command.explanation || command.tool}
          </span>
        </div>
        <span
          className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold shrink-0 ${
            commandResult.success
              ? isUndone
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-[#10B981]/20 text-[#10B981]'
              : 'bg-[#F43F5E]/20 text-[#F43F5E]'
          }`}
        >
          {isUndone ? 'Rolled Back' : commandResult.success ? 'Staged' : 'Failed'}
        </span>
      </div>

      {/* 2. Structured Diff Preview Rows if present */}
      {diffPreview && diffPreview.length > 0 && !isUndone && (
        <div className="flex flex-col gap-1.5 p-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
          <span className="text-[10px] uppercase font-mono text-[#64748B]">Staged Diff Preview</span>
          {diffPreview.map((diff, idx) => (
            <div key={idx} className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-[#94A3B8]">{diff.field}:</span>
              <div className="flex items-center gap-1.5 text-right">
                <span className="text-[#F43F5E] line-through truncate max-w-[110px]">{diff.before}</span>
                <ArrowRight className="w-3 h-3 text-[#64748B] shrink-0" />
                <span className="text-[#10B981] font-semibold truncate max-w-[130px]">{diff.after}</span>
                <span className="text-[10px] text-[#64748B]">({diff.count})</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 3. Result Message */}
      <div className="text-[11px] text-[#94A3B8] font-mono leading-relaxed">
        {isUndone ? undoMessage : commandResult.message}
      </div>

      {/* 4. Action Bar: Two-Phase Commit + One-Click Undo Checkpoint */}
      {commandResult.success && isMutatingCommand && !isUndone && (
        <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px]">
          <button
            onClick={handleUndo}
            title="Revert these staged changes using in-memory checkpoint"
            className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] text-[#94A3B8] hover:text-white border border-white/[0.08] flex items-center gap-1.5 transition-all cursor-pointer font-medium"
          >
            <RotateCcw className="w-3 h-3 text-amber-400" />
            <span>Undo Changes</span>
          </button>

          <button
            onClick={() =>
              dispatcherContext.openModal('commit')
            }
            title="Review sidecars in Two-Phase Commit modal (⌘S)"
            className="px-2.5 py-1 rounded-lg bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/30 flex items-center gap-1.5 transition-all cursor-pointer font-semibold"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
            <span>Review in Commit (⌘S) &rarr;</span>
          </button>
        </div>
      )}
    </div>
  )
}
