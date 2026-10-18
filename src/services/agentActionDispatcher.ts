import { CanvasViewMode, FacetSelections } from '../core/types'
import { auditService } from './auditService'
import { graphEngine } from '../core/graphEngine'
import { agentSnapshotService } from './agentSnapshotService'

export interface AgentActionCommand {
  tool:
    | 'filter_catalog'
    | 'switch_view'
    | 'run_audit'
    | 'remediate_issue'
    | 'select_track'
    | 'open_modal'
    | 'stage_metadata'
    | 'get_statistics'
    | 'reset_filters'
    | 'rework_backdrop'
    | 'execute_pipeline'
  args: Record<string, any>
  explanation?: string
}

export interface AgentPipelineStepResult {
  tool: string
  command: AgentActionCommand
  success: boolean
  message: string
  data?: any
}

export interface AgentPipelineResult {
  success: boolean
  message: string
  stepResults: AgentPipelineStepResult[]
  completedSteps: number
  totalSteps: number
  executed: number
  total: number
}

export interface AgentDispatcherContext {
  setViewMode: (mode: CanvasViewMode) => void
  setFacets: (facets: FacetSelections) => void
  setSearchQuery: (query: string) => void
  setSelectedTrackId: (id: string) => void
  openModal: (modalName: string, payload?: any) => void
  refreshFromEngine: () => void
  showToast: (msg: string) => void
}

export class AgentActionDispatcher {
  /**
   * Executes a structured AI tool command within the application.
   */
  public async executeAction(
    command: AgentActionCommand,
    ctx: AgentDispatcherContext
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      switch (command.tool) {
        case 'filter_catalog': {
          const { composer, era, language, format, genre, mastering, searchQuery } = command.args
          const newFacets: FacetSelections = {}
          if (composer) newFacets.composer = composer
          if (era) newFacets.era = era
          if (language) newFacets.language = language
          if (format) newFacets.format = format
          if (genre) newFacets.genre = genre
          if (mastering) newFacets.mastering = mastering

          ctx.setFacets(newFacets)
          if (typeof searchQuery === 'string') {
            ctx.setSearchQuery(searchQuery)
          }

          const filteredCount = graphEngine.getAllTracks().filter((t) => {
            if (newFacets.composer && !t.composerName?.toLowerCase().includes(newFacets.composer.toLowerCase()) && !t.artistCredit?.toLowerCase().includes(newFacets.composer.toLowerCase())) return false
            if (newFacets.format && t.format?.toUpperCase() !== newFacets.format.toUpperCase()) return false
            if (newFacets.language && t.language?.toLowerCase() !== newFacets.language.toLowerCase()) return false
            return true
          }).length

          const filterDesc = Object.entries(newFacets).map(([k, v]) => `${k}: ${v}`).join(', ')
          return {
            success: true,
            message: `Applied catalog filters (${filterDesc || 'text search'}). ${filteredCount} track(s) matched.`,
          }
        }

        case 'reset_filters': {
          ctx.setFacets({})
          ctx.setSearchQuery('')
          return { success: true, message: 'Reset all active catalog filters to show entire library.' }
        }

        case 'switch_view': {
          const mode = command.args.viewMode as CanvasViewMode
          if (['virtual_table', 'variant_stack', 'work_movement'].includes(mode)) {
            ctx.setViewMode(mode)
            const labels: Record<string, string> = {
              virtual_table: 'Virtual Data Grid & Spreadsheet Multi-Edit',
              variant_stack: 'Master Pressing & Variant Stacks',
              work_movement: 'Classical Works & Multi-Part Movements',
            }
            return {
              success: true,
              message: `Switched center stage view to "${labels[mode] || mode}".`,
            }
          }
          return { success: false, message: `Invalid view mode: "${mode}".` }
        }

        case 'run_audit': {
          const issues = auditService.runFullCatalogAudit()
          ctx.refreshFromEngine()
          const totalAnomalies = issues.reduce((acc, i) => acc + i.affectedCount, 0)
          return {
            success: true,
            message: `Completed diagnostic scan. Found ${issues.length} issue categories (${totalAnomalies} anomalies).`,
            data: issues,
          }
        }

        case 'remediate_issue': {
          const actionType = command.args.actionType || command.args.autoFixAction || command.args.issueId
          const res = await auditService.remediateIssue(actionType, command.args)
          ctx.refreshFromEngine()
          if (res.success) {
            ctx.showToast(res.message)
          }
          return res
        }

        case 'rework_backdrop': {
          const res = await auditService.remediateIssue('REWORK_BACKDROP', command.args)
          ctx.refreshFromEngine()
          if (res.success) {
            ctx.showToast(res.message)
          }
          return res
        }

        case 'stage_metadata': {
          const commands: AgentActionCommand[] = []
          if (
            command.args.coverArtUrl ||
            command.args.actionType === 'FETCH_HIRES_ART' ||
            command.args.action === 'FETCH_HIRES_ART' ||
            command.args.provider
          ) {
            commands.push({
              tool: 'remediate_issue',
              args: { actionType: 'FETCH_HIRES_ART', ...command.args },
              explanation: command.explanation || 'Staging high-resolution cover art into metadata sidecars.',
            })
          }
          if (
            command.args.backdropUrl ||
            command.args.actionType === 'REWORK_BACKDROP' ||
            command.args.reworkBackdrop
          ) {
            commands.push({
              tool: 'rework_backdrop',
              args: command.args,
              explanation: command.explanation || 'Applying high-resolution album backdrops in Virtual Grid.',
            })
          }
          if (commands.length > 1) {
            const pipeRes = await this.executePipeline(commands, ctx)
            return { success: pipeRes.success, message: pipeRes.message, data: pipeRes }
          }
          if (commands.length === 1) {
            return this.executeAction(commands[0], ctx)
          }
          return { success: false, message: 'Unsupported stage_metadata payload.' }
        }

        case 'execute_pipeline': {
          const commands: AgentActionCommand[] = command.args.commands || []
          if (!Array.isArray(commands) || commands.length === 0) {
            return { success: false, message: 'execute_pipeline requires a non-empty "commands" array.' }
          }
          const pipeRes = await this.executePipeline(commands, ctx, command.args.stopOnError !== false)
          return {
            success: pipeRes.success,
            message: pipeRes.message,
            data: pipeRes,
          }
        }

        case 'open_modal': {
          const modal = command.args.modalName
          ctx.openModal(modal, command.args.payload)
          return { success: true, message: `Opened ${modal} modal.` }
        }

        case 'select_track': {
          const { trackId, query } = command.args
          let target = trackId ? graphEngine.getTrackById(trackId) : undefined
          if (!target && query) {
            const all = graphEngine.getAllTracks()
            target = all.find((t) => t.title.toLowerCase().includes(query.toLowerCase()) || t.artistCredit.toLowerCase().includes(query.toLowerCase()))
          }
          if (target) {
            ctx.setSelectedTrackId(target.id)
            return { success: true, message: `Selected track "${target.title}" by ${target.artistCredit}.`, data: target }
          }
          return { success: false, message: `Could not locate track matching "${query || trackId}".` }
        }

        case 'get_statistics': {
          const stats = agentSnapshotService.getCatalogStatistics()
          return {
            success: true,
            message: `Retrieved live database statistics: ${stats.totalTracks} tracks across ${stats.totalReleases} albums.`,
            data: stats,
          }
        }

        default:
          return { success: false, message: `Unknown tool directive: "${command.tool}".` }
      }
    } catch (err: any) {
      return { success: false, message: `Action failed: ${err.message}` }
    }
  }

  /**
   * Executes a sequential pipeline of tool commands, capturing step-by-step progress and safely reporting failures.
   */
  public async executePipeline(
    commands: AgentActionCommand[],
    ctx: AgentDispatcherContext,
    stopOnError = true
  ): Promise<AgentPipelineResult> {
    const stepResults: AgentPipelineStepResult[] = []
    let allSuccess = true

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]
      const stepRes = await this.executeAction(cmd, ctx)
      stepResults.push({
        tool: cmd.tool,
        command: cmd,
        success: stepRes.success,
        message: stepRes.message,
        data: stepRes.data,
      })

      if (!stepRes.success) {
        allSuccess = false
        if (stopOnError) {
          break
        }
      }
    }

    const completed = stepResults.filter((s) => s.success).length
    const total = commands.length
    const summaryMsg = allSuccess
      ? `Completed compound pipeline: ${completed}/${total} steps executed successfully.`
      : `Pipeline halted: ${completed}/${total} steps completed. Error on step ${stepResults.length}: ${
          stepResults[stepResults.length - 1]?.message
        }`

    return {
      success: allSuccess,
      message: summaryMsg,
      stepResults,
      completedSteps: completed,
      totalSteps: total,
      executed: completed,
      total,
    }
  }

  /**
   * Parses a single clause into an AgentActionCommand.
   */
  public parseSingleLocalIntent(prompt: string, contextArgs: Record<string, any> = {}): AgentActionCommand | null {
    const p = prompt.toLowerCase().trim()
    if (!p) return null

    // 1. Cover Artwork Remediation & Staging (Prioritized)
    if (
      /\b(?:fetch|get|download|find|stage|resolve|add)\b.*?\b(?:art|artwork|covers?)\b/i.test(p) ||
      /\b(?:cover\s*art|artwork|covers?)\b.*?\b(?:apple|itunes|musicbrainz|stage|online|authorit)\b/i.test(p) ||
      /\b(?:no|missing|low-res|lowres)\s+(?:cover\s*art|artwork|covers?)\b/i.test(p) ||
      /\b(fetch art|archival art|download covers?|hires art)\b/i.test(p)
    ) {
      const provider = /\b(?:apple(?:\s*music)?|itunes)\b/i.test(p)
        ? 'apple'
        : /\b(?:musicbrainz|caa)\b/i.test(p)
        ? 'musicbrainz'
        : /\b(?:ai|gemini)\b/i.test(p)
        ? 'ai'
        : contextArgs.provider

      return {
        tool: 'remediate_issue',
        args: { actionType: 'FETCH_HIRES_ART', ...(provider ? { provider } : {}) },
        explanation: `Triggering the automated fetch process to resolve missing/low-res cover art across the library${
          provider === 'apple' ? ' from Apple Music' : ''
        }.`,
      }
    }

    // 2. Backdrop / Panoramic Wallpaper Rework & Application
    if (
      /\b(?:rework|generate|apply|create|update|set|map)\b.*?\bbackdrops?\b/i.test(p) ||
      /\bbackdrops?\b/i.test(p)
    ) {
      const rahmanMatch = /\b(?:a\.?\s*r\.?\s*rahman|rahman)\b/i.test(p) ? 'A. R. Rahman' : contextArgs.composer
      const provider = /\b(?:apple(?:\s*music)?|itunes)\b/i.test(p)
        ? 'apple'
        : /\b(?:musicbrainz|caa)\b/i.test(p)
        ? 'musicbrainz'
        : contextArgs.provider

      return {
        tool: 'rework_backdrop',
        args: {
          actionType: 'REWORK_BACKDROP',
          ...(rahmanMatch ? { composer: rahmanMatch, artist: rahmanMatch } : {}),
          ...(provider ? { provider } : {}),
        },
        explanation:
          'Initiating high-resolution cover art retrieval and applying it as the album backdrop to resolve the visual deficiency in the Virtual Grid.',
      }
    }

    // 3. Metadata Remediations
    if (
      /\b(?:extract|resolve|unknown|auto\s*tag|tag\s+from)\b.*?\b(?:artists?|folders?)\b/i.test(p) ||
      /\b(unknown artists|auto tag)\b/i.test(p)
    ) {
      return { tool: 'remediate_issue', args: { actionType: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER' } }
    }
    if (
      /\b(?:normalize|clean(?:\s*up)?|merge|unify)\b.*?\bgenres?\b/i.test(p) ||
      (/\bgenres?\b/i.test(p) && /\b(?:normalize|clean|unify)\b/i.test(p))
    ) {
      return { tool: 'remediate_issue', args: { actionType: 'NORMALIZE_GENRES' } }
    }
    if (
      /\b(?:merge|canonicalize|deduplicate|clean(?:\s*up)?)\b.*?\b(?:performers?|artists?|authorit(?:y|ies))\b/i.test(p)
    ) {
      return { tool: 'remediate_issue', args: { actionType: 'MERGE_DUPLICATE_PERFORMERS' } }
    }
    if (
      /\b(?:disentangle|sync|boxset|conflict)\b.*?\b(?:folder|boxset|album(?:\s*names?)?)\b/i.test(p)
    ) {
      return { tool: 'remediate_issue', args: { actionType: 'SYNC_FOLDER_TO_ALBUM' } }
    }

    // 4. Statistics / Status
    if (/\b(stats|statistics|summary|count|how many|collection size|breakdown)\b/i.test(p)) {
      return { tool: 'get_statistics', args: {} }
    }

    // 5. Audit / Hygiene
    if (/\b(audit|scan library|run audit|health scan|hygiene|check health)\b/i.test(p)) {
      return { tool: 'run_audit', args: {} }
    }

    // 6. View Switching
    if (/\b(grid|spreadsheet|virtual table|table view|show table|virtual grid)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'virtual_table' } }
    }
    if (/\b(stacks|variants|variant stack|album view|show albums)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'variant_stack' } }
    }
    if (/\b(classical|movements?|works? view|symphon)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'work_movement' } }
    }

    // 7. Filters
    if (/\b(filter to 24-bit|hi-res|high res|24bit)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { mastering: 'high_res_24bit' } }
    }
    if (/\b(dsd|show dsd|filter dsd)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { format: 'DSD' } }
    }
    if (/\b(wav|filter wav|pcm)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { format: 'WAV' } }
    }
    if (/\b(flac|filter flac)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { format: 'FLAC' } }
    }
    if (/\b(tamil|filter tamil)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { language: 'Tamil' } }
    }
    if (/\b(hindi|filter hindi|bollywood)\b/i.test(p)) {
      return { tool: 'filter_catalog', args: { language: 'Hindi' } }
    }
    if (/\b(?:reset|clear)\s+(?:all\s+)?(?:active\s+)?filters?\b|\b(?:show\s+all(?:\s+tracks)?)\b/i.test(p)) {
      return { tool: 'reset_filters', args: {} }
    }

    // 8. Modals
    if (/\b(commit|stage sidecars?|two phase commit|write sidecars?)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'commit' } }
    }
    if (/\b(import|scan folder|import modal|add music)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'import' } }
    }
    if (/\b(path\s*rules?|restructur\w*|renam\w*\s*rules?|naming\s*rules?)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'path_rules' } }
    }

    return null
  }

  /**
   * Robust compound local intent parser that extracts multiple distinct operations from natural language requests.
   */
  public parseCompoundLocalIntent(prompt: string): AgentActionCommand[] {
    const p = prompt.trim()
    if (!p) return []

    // Detect shared context such as provider or composer mentioned anywhere in the overall prompt
    const sharedProvider = /\b(?:apple(?:\s*music)?|itunes)\b/i.test(p)
      ? 'apple'
      : /\b(?:musicbrainz|caa)\b/i.test(p)
      ? 'musicbrainz'
      : /\b(?:ai|gemini)\b/i.test(p)
      ? 'ai'
      : undefined

    const sharedComposer = /\b(?:a\.?\s*r\.?\s*rahman|rahman)\b/i.test(p)
      ? 'A. R. Rahman'
      : /\b(?:beethoven|ludwig)\b/i.test(p)
      ? 'Ludwig van Beethoven'
      : /\b(?:miles\s*davis|miles)\b/i.test(p)
      ? 'Miles Davis'
      : undefined

    const contextArgs: Record<string, any> = {}
    if (sharedProvider) contextArgs.provider = sharedProvider
    if (sharedComposer) {
      contextArgs.composer = sharedComposer
      contextArgs.artist = sharedComposer
    }

    // Split on compound sequence conjunctions: "and then", "then", "followed by", "after that", "also", "and", ";", "+"
    const clauses = p
      .split(/\b(?:and\s+then|then|followed\s+by|after\s+that|\balso\b|\band\b|;|\+)\b/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 2)

    const commands: AgentActionCommand[] = []

    for (const clause of clauses) {
      const cmd = this.parseSingleLocalIntent(clause, contextArgs)
      if (cmd) {
        // Deduplicate identical adjacent tool invocations with identical parameters
        const isDuplicate = commands.some(
          (existing) =>
            existing.tool === cmd.tool &&
            JSON.stringify(existing.args) === JSON.stringify(cmd.args)
        )
        if (!isDuplicate) {
          commands.push(cmd)
        }
      }
    }

    // Co-occurrence fallback:
    // If splitting by conjunctions didn't detect multiple distinct tools,
    // check if distinct strong intents co-occur in the full prompt (e.g. art fetch + backdrop rework)
    if (commands.length <= 1) {
      const hasArtFetch =
        /\b(?:fetch|get|download|find|stage|resolve|add)\b.*?\b(?:art|artwork|covers?)\b/i.test(p) ||
        /\b(?:cover\s*art|artwork|covers?)\b.*?\b(?:apple|itunes|musicbrainz|stage|online)\b/i.test(p)
      const hasBackdrop =
        /\b(?:rework|generate|apply|create|update|set|map)\b.*?\bbackdrops?\b/i.test(p) || /\bbackdrops?\b/i.test(p)

      if (hasArtFetch && hasBackdrop) {
        const artIdx = p.search(/\b(?:art|artwork|covers?)\b/i)
        const backdropIdx = p.search(/\bbackdrops?\b/i)
        const artCmd: AgentActionCommand = {
          tool: 'remediate_issue',
          args: { actionType: 'FETCH_HIRES_ART', ...(sharedProvider ? { provider: sharedProvider } : {}) },
          explanation: `Triggering automated fetch to resolve cover art${sharedProvider === 'apple' ? ' from Apple Music' : ''}.`,
        }
        const backdropCmd: AgentActionCommand = {
          tool: 'rework_backdrop',
          args: {
            actionType: 'REWORK_BACKDROP',
            ...(sharedComposer ? { composer: sharedComposer, artist: sharedComposer } : {}),
            ...(sharedProvider ? { provider: sharedProvider } : {}),
          },
          explanation: 'Rework and apply panoramic album backdrops in Virtual Grid.',
        }

        const coOccurred = artIdx <= backdropIdx ? [artCmd, backdropCmd] : [backdropCmd, artCmd]
        if (coOccurred.length > commands.length) {
          return coOccurred
        }
      }
    }

    return commands
  }

  /**
   * Deterministic local fallback intent parser for common user commands when offline or for fast execution.
   * If compound clauses are present, returns an execute_pipeline compound action.
   */
  public parseLocalIntent(prompt: string): AgentActionCommand | null {
    const compound = this.parseCompoundLocalIntent(prompt)
    if (compound.length > 1) {
      return {
        tool: 'execute_pipeline',
        args: { commands: compound },
        explanation: `Executing compound multi-step workflow (${compound.length} operations).`,
      }
    }
    if (compound.length === 1) {
      return compound[0]
    }
    return null
  }
}

export const agentActionDispatcher = new AgentActionDispatcher()
