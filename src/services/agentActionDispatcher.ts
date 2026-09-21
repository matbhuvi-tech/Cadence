import { CanvasViewMode } from '../components/CenterStage/DataCanvas'
import { FacetSelections } from '../components/LeftRail/FacetedFilters'
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
  args: Record<string, any>
  explanation?: string
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
          const res = await auditService.remediateIssue(actionType)
          ctx.refreshFromEngine()
          if (res.success) {
            ctx.showToast(res.message)
          }
          return res
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
   * Deterministic local fallback intent parser for common user commands when offline or for fast execution.
   */
  public parseLocalIntent(prompt: string): AgentActionCommand | null {
    const p = prompt.toLowerCase().trim()

    // Statistics / Status
    if (/\b(stats|statistics|summary|count|how many|collection size|breakdown)\b/i.test(p)) {
      return { tool: 'get_statistics', args: {} }
    }

    // View Switching
    if (/\b(grid|spreadsheet|virtual table|table view|show table)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'virtual_table' } }
    }
    if (/\b(stacks|variants|variant stack|album view|show albums)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'variant_stack' } }
    }
    if (/\b(classical|movements?|works? view|symphon)\b/i.test(p)) {
      return { tool: 'switch_view', args: { viewMode: 'work_movement' } }
    }

    // Audit / Hygiene
    if (/\b(audit|scan library|run audit|health scan|hygiene|check health)\b/i.test(p)) {
      return { tool: 'run_audit', args: {} }
    }

    // Remediations
    if (/\b(extract artists|resolve artists|unknown artists|auto tag|tag from folders?)\b/i.test(p)) {
      return { tool: 'remediate_issue', args: { actionType: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER' } }
    }
    if (/\b(normalize genres?|clean genres?|merge genres?)\b/i.test(p)) {
      return { tool: 'remediate_issue', args: { actionType: 'NORMALIZE_GENRES' } }
    }
    if (/\b(merge performers?|canonicalize artists?|clean performers?)\b/i.test(p)) {
      return { tool: 'remediate_issue', args: { actionType: 'MERGE_DUPLICATE_PERFORMERS' } }
    }
    if (/\b(disentangle|sync folder|boxset conflict|sync album names?)\b/i.test(p)) {
      return { tool: 'remediate_issue', args: { actionType: 'SYNC_FOLDER_TO_ALBUM' } }
    }
    if (/\b(fetch art|archival art|download covers?|hires art)\b/i.test(p)) {
      return { tool: 'remediate_issue', args: { actionType: 'FETCH_HIRES_ART' } }
    }

    // Filters
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
    if (/\b(reset filters?|clear filters?|show all)\b/i.test(p)) {
      return { tool: 'reset_filters', args: {} }
    }

    // Modals
    if (/\b(commit|stage sidecars?|two phase commit|write sidecars?)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'commit' } }
    }
    if (/\b(import|scan folder|import modal|add music)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'import' } }
    }
    if (/\b(path rules?|restructure|renaming rules?)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'path_rules' } }
    }

    return null
  }
}

export const agentActionDispatcher = new AgentActionDispatcher()
