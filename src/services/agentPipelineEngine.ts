/**
 * src/services/agentPipelineEngine.ts
 * Robust execution engine for sequential multi-command pipelines with
 * in-memory state checkpointing, atomic rollback, and progress telemetry.
 */

import {
  AgentActionCommand,
  AgentActionPipeline,
  AgentPipelineResult,
  AgentStepResult,
} from './agentTypes'
import { agentActionDispatcher, AgentDispatcherContext } from './agentActionDispatcher'
import { graphEngine } from '../core/graphEngine'

export interface PipelineProgressCallback {
  (currentStepIndex: number, totalSteps: number, step: AgentActionCommand, status: AgentStepResult): void
}

export interface StagedCheckpoint {
  id: string
  timestamp: number
  description: string
  tracksJson: string
  releasesJson: string
}

export class AgentPipelineEngine {
  private checkpointHistory: StagedCheckpoint[] = []

  /**
   * Captures an in-memory snapshot of the tracks/releases before running a mutating pipeline.
   */
  public createCheckpoint(description: string): StagedCheckpoint {
    const checkpoint: StagedCheckpoint = {
      id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      description,
      tracksJson: JSON.stringify(graphEngine.getAllTracks()),
      releasesJson: JSON.stringify(graphEngine.getAllReleases()),
    }
    this.checkpointHistory.push(checkpoint)
    // Keep at most 10 recent checkpoints in memory
    if (this.checkpointHistory.length > 10) {
      this.checkpointHistory.shift()
    }
    return checkpoint
  }

  /**
   * Restores graphEngine state from an in-memory checkpoint.
   */
  public restoreCheckpoint(checkpointId?: string): boolean {
    const cp = checkpointId
      ? this.checkpointHistory.find((c) => c.id === checkpointId)
      : this.checkpointHistory[this.checkpointHistory.length - 1]

    if (!cp) return false

    try {
      const tracks = JSON.parse(cp.tracksJson)
      const releases = JSON.parse(cp.releasesJson)
      graphEngine.loadCustomLibrary({
        tracks,
        releases,
        works: graphEngine.getAllWorks(),
        auditIssues: graphEngine.getAllAuditIssues(),
        storageMounts: graphEngine.getAllStorageMounts(),
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Reverts the most recent pipeline changes.
   */
  public undoLastPipeline(ctx: AgentDispatcherContext): { success: boolean; message: string } {
    if (this.checkpointHistory.length === 0) {
      return { success: false, message: 'No prior Copilot checkpoint available to undo.' }
    }
    const last = this.checkpointHistory.pop()!
    const restored = this.restoreCheckpoint(last.id)
    if (restored) {
      ctx.refreshFromEngine()
      ctx.showToast(`Undone: ${last.description}`)
      return { success: true, message: `Successfully restored library state to before "${last.description}".` }
    }
    return { success: false, message: 'Failed to restore prior checkpoint.' }
  }

  /**
   * Executes a multi-command pipeline with sequential dependency tracking and error safety.
   */
  public async executePipeline(
    pipeline: AgentActionPipeline | { commands: AgentActionCommand[]; stopOnError?: boolean; atomic?: boolean },
    ctx: AgentDispatcherContext,
    onProgress?: PipelineProgressCallback
  ): Promise<AgentPipelineResult> {
    const rawCommands: AgentActionCommand[] = Array.isArray((pipeline as any).steps)
      ? (pipeline as AgentActionPipeline).steps
      : Array.isArray((pipeline as any).commands)
      ? (pipeline as any).commands
      : []

    if (rawCommands.length === 0) {
      return {
        success: false,
        executed: 0,
        total: 0,
        completedSteps: 0,
        totalSteps: 0,
        stepResults: [],
        message: 'No commands supplied to pipeline engine.',
      }
    }

    const title = (pipeline as any).title || (pipeline as any).description || `Pipeline (${rawCommands.length} steps)`
    const stopOnError = (pipeline as any).stopOnError ?? true
    const atomic = (pipeline as any).atomic ?? true

    // Checkpoint before executing mutating pipelines
    const checkpoint = atomic ? this.createCheckpoint(title) : null

    const stepResults: AgentStepResult[] = []
    let pipelineFailed = false

    for (let i = 0; i < rawCommands.length; i++) {
      const cmd = rawCommands[i]
      const startTime = Date.now()

      if (onProgress) {
        onProgress(i, rawCommands.length, cmd, {
          step: i + 1,
          tool: cmd.tool,
          status: 'executing',
          success: false,
          message: `Executing ${cmd.explanation || cmd.tool}...`,
          explanation: cmd.explanation,
          durationMs: 0,
        })
      }

      try {
        const res = await agentActionDispatcher.executeAction(cmd, ctx)
        const durationMs = Date.now() - startTime

        const stepResult: AgentStepResult = {
          step: i + 1,
          tool: cmd.tool,
          status: res.success ? 'succeeded' : 'failed',
          success: res.success,
          message: res.message,
          explanation: cmd.explanation,
          data: res.data,
          durationMs,
        }
        stepResults.push(stepResult)

        if (onProgress) {
          onProgress(i, rawCommands.length, cmd, stepResult)
        }

        if (!res.success && !cmd.optional) {
          pipelineFailed = true
          if (stopOnError) {
            // Mark remaining steps as skipped
            for (let j = i + 1; j < rawCommands.length; j++) {
              const skippedCmd = rawCommands[j]
              stepResults.push({
                step: j + 1,
                tool: skippedCmd.tool,
                status: 'skipped',
                success: false,
                message: 'Skipped due to prior step failure in pipeline.',
                explanation: skippedCmd.explanation,
                durationMs: 0,
              })
            }
            break
          }
        }
      } catch (err: any) {
        stepResults.push({
          step: i + 1,
          tool: cmd.tool,
          status: 'failed',
          success: false,
          message: err.message || 'Exception during step execution',
          explanation: cmd.explanation,
          durationMs: Date.now() - startTime,
        })
        pipelineFailed = true
        break
      }
    }

    let rolledBack = false
    if (pipelineFailed && atomic && checkpoint) {
      this.restoreCheckpoint(checkpoint.id)
      ctx.refreshFromEngine()
      rolledBack = true
    }

    const completedCount = stepResults.filter((r) => r.success).length

    const summary = rolledBack
      ? `Pipeline halted at step ${stepResults.length} and changes were rolled back.`
      : `Executed ${completedCount} of ${rawCommands.length} step(s) in sequence.`

    return {
      pipelineId: checkpoint?.id,
      success: !pipelineFailed,
      executed: completedCount,
      total: rawCommands.length,
      completedSteps: completedCount,
      totalSteps: rawCommands.length,
      stepResults,
      snapshotId: checkpoint?.id,
      rolledBack,
      message: summary,
      summaryMessage: summary,
    }
  }
}

export const agentPipelineEngine = new AgentPipelineEngine()
