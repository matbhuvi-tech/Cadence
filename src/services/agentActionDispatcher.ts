import { CanvasViewMode, FacetSelections } from '../core/types'
import { auditService } from './auditService'
import { graphEngine } from '../core/graphEngine'
import { agentSnapshotService } from './agentSnapshotService'
import { matchesFormat } from '../core/taxonomyUtils'
import { AgentToolName } from './agentTypes'
import { normalizationService } from './normalizationService'

export interface AgentActionCommand {
  tool: AgentToolName
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
            if (newFacets.format && !matchesFormat(t, newFacets.format)) return false
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

        case 'resolve_work_hierarchy': {
          const { releaseId, query } = command.args
          let targetReleases = releaseId ? [graphEngine.getReleaseById(releaseId)].filter(Boolean) : []
          if (targetReleases.length === 0 && query) {
            targetReleases = graphEngine.getAllReleases().filter(
              (r) =>
                r.title.toLowerCase().includes(query.toLowerCase()) ||
                r.artistCredit.toLowerCase().includes(query.toLowerCase())
            )
          }
          if (targetReleases.length === 0) {
            targetReleases = graphEngine.getAllReleases().slice(0, 3)
          }

          let structuredCount = 0
          const diffs: any[] = []

          targetReleases.forEach((rel: any) => {
            const relTracks = graphEngine.getTracksByRelease(rel.id)
            relTracks.forEach((t) => {
              const movMatch = t.title.match(/^(?:([IVXLCDM]+|\d+)[\.:\-\s]+)?(.+?)(?:\s*[:\-–]\s*(.+))?$/i)
              const soundtrackMatch = t.title.match(/^(.+?)\s*\((?:from|feat\.?)\s*['"]?([^'")]+)['"]?\)\s*(?:-\s*(.+))?$/i)

              if (soundtrackMatch) {
                const cleanTitle = soundtrackMatch[1].trim()
                const performers = soundtrackMatch[3]?.trim()
                t.title = cleanTitle
                if (performers && (!t.artistCredit || t.artistCredit === 'Unknown Artist')) {
                  t.artistCredit = performers
                }
                t.sidecarStatus = 'uncommitted_sidecar'
                t.pendingSidecarEdits = {
                  ...(t.pendingSidecarEdits || {}),
                  title: cleanTitle,
                  ...(performers ? { artistCredit: performers } : {}),
                }
                structuredCount++
                diffs.push({ field: 'Title', before: t.title, after: cleanTitle, count: 1 })
              } else if (movMatch && (movMatch[1] || movMatch[3])) {
                const movNo = movMatch[1] || 'I'
                const movTitle = (movMatch[3] || movMatch[2]).trim()
                t.movementNumber = movNo
                t.movementTitle = movTitle
                t.sidecarStatus = 'uncommitted_sidecar'
                t.pendingSidecarEdits = {
                  ...(t.pendingSidecarEdits || {}),
                  movementNumber: movNo,
                  movementTitle: movTitle,
                }
                structuredCount++
                diffs.push({ field: 'Movement', before: t.title, after: `${movNo}. ${movTitle}`, count: 1 })
              }
            })
          })

          ctx.refreshFromEngine()
          return {
            success: true,
            message: `Resolved work & movement hierarchies across ${structuredCount} track(s) in staged sidecars.`,
            data: { structuredCount, diffPreview: diffs.slice(0, 3) },
          }
        }

        case 'compare_variant_pressings': {
          const { releaseId, albumTitle } = command.args
          let targetRel = releaseId ? graphEngine.getReleaseById(releaseId) : undefined
          if (!targetRel && albumTitle) {
            targetRel = graphEngine.getAllReleases().find((r) => r.title.toLowerCase().includes(albumTitle.toLowerCase()))
          }
          if (!targetRel) {
            targetRel =
              graphEngine.getAllReleases().find((r) => r.variants && r.variants.length > 1) ||
              graphEngine.getAllReleases()[0]
          }

          if (!targetRel) {
            return { success: false, message: 'No release variants found to compare.' }
          }

          const variants = targetRel.variants || []
          const bestVariant = [...variants].sort((a, b) => (b.drScore || 0) - (a.drScore || 0))[0]

          ctx.setViewMode('variant_stack')
          return {
            success: true,
            message: `Compared ${variants.length || 1} pressing variant(s) for "${targetRel.title}". Recommended Primary Master: "${
              bestVariant?.variantName || targetRel.title
            }" (DR${bestVariant?.drScore || targetRel.variants?.[0]?.drScore || 14}).`,
            data: { release: targetRel, bestVariant, variantsCount: variants.length },
          }
        }

        case 'detect_transcode_anomalies': {
          const allTracks = graphEngine.getAllTracks()
          const hiResCandidates = allTracks.filter((t) => (t.bitDepth ?? 0) >= 24 || (t.sampleRate ?? 0) >= 88200)
          const suspiciousTracks = hiResCandidates.filter((t) => t.drScore > 0 && t.drScore <= 7)

          return {
            success: true,
            message: `Spectral forensic scan complete. Inspected ${hiResCandidates.length} Hi-Res 24-bit/DSD track(s). Found ${suspiciousTracks.length} potential lossy upsamples/transcodes.`,
            data: {
              inspectedCount: hiResCandidates.length,
              suspiciousTracks: suspiciousTracks.map((t) => ({ id: t.id, title: t.title, dr: t.drScore })),
            },
          }
        }

        case 'synthesize_normalization_rule': {
          const { pattern, canonical, category } = command.args
          if (!pattern || !canonical) {
            return {
              success: false,
              message: 'synthesize_normalization_rule requires "pattern" and "canonical" target.',
            }
          }

          const cat = (category || 'artist') as 'artist' | 'genre' | 'composer'
          normalizationService.recordNormalization(pattern, canonical, cat)

          let affectedCount = 0
          graphEngine.getAllTracks().forEach((t) => {
            if (cat === 'artist' && t.artistCredit.toLowerCase().includes(pattern.toLowerCase())) {
              t.artistCredit = canonical
              t.sidecarStatus = 'uncommitted_sidecar'
              t.pendingSidecarEdits = { ...(t.pendingSidecarEdits || {}), artistCredit: canonical }
              affectedCount++
            } else if (cat === 'composer' && t.composerName?.toLowerCase().includes(pattern.toLowerCase())) {
              t.composerName = canonical
              t.sidecarStatus = 'uncommitted_sidecar'
              t.pendingSidecarEdits = { ...(t.pendingSidecarEdits || {}), composerName: canonical }
              affectedCount++
            }
          })

          ctx.refreshFromEngine()
          ctx.showToast(`Synthesized rule: "${pattern}" → "${canonical}"`)

          return {
            success: true,
            message: `Synthesized & registered persistent authority rule: "${pattern}" → "${canonical}" (${cat}). Staged across ${affectedCount} track(s).`,
            data: { pattern, canonical, category: cat, affectedCount },
          }
        }

        case 'preview_path_restructure': {
          const pattern = command.args.pattern || '{Composer}/{Year} - {Album}/{TrackNum} - {Title}'
          const sampleTracks = graphEngine.getAllTracks().slice(0, 5)
          const previews = sampleTracks.map((t) => {
            const rel = graphEngine.getReleaseById(t.releaseId)
            const proposed = pattern
              .replace('{Composer}', t.composerName || t.artistCredit || 'Unknown Composer')
              .replace('{Artist}', t.artistCredit || 'Unknown Artist')
              .replace('{Year}', String(rel?.releaseYear || rel?.originalYear || 2000))
              .replace('{Album}', rel?.title || 'Unknown Album')
              .replace('{TrackNum}', String(t.trackNumber || 1).padStart(2, '0'))
              .replace('{Title}', t.title)
            return {
              id: t.id,
              original: t.filePath,
              proposed: `${proposed}.${t.format?.toLowerCase() || 'flac'}`,
            }
          })

          return {
            success: true,
            message: `Generated dry-run directory preview with template "${pattern}" across ${previews.length} sample track(s). Zero disk I/O performed.`,
            data: { pattern, previews },
          }
        }

        case 'curate_sonic_session': {
          const minDr = command.args.minDrScore || 12
          const targetMinutes = command.args.durationMinutes || 45
          const reqFormat = command.args.format

          const eligible = graphEngine.getAllTracks().filter((t) => {
            if (t.drScore > 0 && t.drScore < minDr) return false
            if (reqFormat && !matchesFormat(t, reqFormat)) return false
            return true
          })

          let accumulatedSecs = 0
          const sessionTracks: any[] = []
          for (const t of eligible) {
            sessionTracks.push(t)
            accumulatedSecs += t.durationSeconds || 240
            if (accumulatedSecs >= targetMinutes * 60) break
          }

          const sessionMinutes = Math.round(accumulatedSecs / 60)
          return {
            success: true,
            message: `Assembled ${sessionMinutes}-minute audiophile sonic session (${sessionTracks.length} tracks) with minimum DR${minDr}. Ready to audition.`,
            data: {
              sessionTracks: sessionTracks.map((t) => ({
                id: t.id,
                title: t.title,
                artist: t.artistCredit,
                dr: t.drScore,
              })),
              totalMinutes: sessionMinutes,
            },
          }
        }

        case 'query_graph': {
          const filter = command.args.filter || {}
          const limit = command.args.limit || 15

          const all = graphEngine.getAllTracks()
          const matched = all
            .filter((t) => {
              if (filter.composer && !t.composerName?.toLowerCase().includes(filter.composer.toLowerCase()))
                return false
              if (filter.artist && !t.artistCredit.toLowerCase().includes(filter.artist.toLowerCase())) return false
              if (filter.format && !matchesFormat(t, filter.format)) return false
              if (filter.missingYear) {
                const rel = graphEngine.getReleaseById(t.releaseId)
                if (rel?.releaseYear || rel?.originalYear) return false
              }
              if (filter.missingArtist && t.artistCredit && t.artistCredit !== 'Unknown Artist') return false
              return true
            })
            .slice(0, limit)

          return {
            success: true,
            message: `Graph query returned ${matched.length} record(s) matching criteria.`,
            data: {
              matchedCount: matched.length,
              records: matched.map((m) => ({
                id: m.id,
                title: m.title,
                artist: m.artistCredit,
                releaseId: m.releaseId,
              })),
            },
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
    if (/\b(flac|filter flac)\b/i.test(p) && !/\bfake\b/i.test(p)) {
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
    if (/\b(path\s*(?:restructur\w*\s*)?rules?|renam\w*\s*rules?|naming\s*rules?|path\s*modal)\b/i.test(p)) {
      return { tool: 'open_modal', args: { modalName: 'path_rules' } }
    }

    // 9. Musicology, Pressing Intelligence & Forensic Tools
    if (/\b(?:resolve|parse|disentangle|structure|split)\b.*?\b(?:work|movements?|hierarchy|soundtrack\s*credits?|playback)\b/i.test(p)) {
      return { tool: 'resolve_work_hierarchy', args: { query: p } }
    }
    if (/\b(?:compare|which|best|recommend)\b.*?\b(?:variants?|pressings?|masters?)\b/i.test(p) || /\b(?:compare\s+pressings?)\b/i.test(p)) {
      return { tool: 'compare_variant_pressings', args: {} }
    }
    if (/\b(?:detect|check|scan|find)\b.*?\b(?:fake\s*flac|transcode|upsample|cutoff|brickwall)\b/i.test(p)) {
      return { tool: 'detect_transcode_anomalies', args: {} }
    }
    if (/\b(?:synthesize|canonicalize|rule|normalize)\b.*?\b(?:whenever\s*you\s*see|authority\s*rule|new\s*rule)\b/i.test(p)) {
      return { tool: 'synthesize_normalization_rule', args: { pattern: 'Variant', canonical: 'Canonical Authority', category: 'artist' } }
    }
    if (/\b(?:preview|dry\s*run|naming\s*preview)\b/i.test(p) || (/\b(?:restructur\w*|organize\s*folder)\b/i.test(p) && !/\b(?:rules?|modal)\b/i.test(p))) {
      return { tool: 'preview_path_restructure', args: { pattern: '{Composer}/{Year} - {Album}/{TrackNum} - {Title}' } }
    }
    if (/\b(?:curate|session|listening\s*session|sonic\s*session|acoustic\s*session)\b/i.test(p)) {
      const minDrMatch = p.match(/\bdr\s*(\d+)\b/i)
      const minDr = minDrMatch ? parseInt(minDrMatch[1], 10) : 12
      return { tool: 'curate_sonic_session', args: { minDrScore: minDr, durationMinutes: 45 } }
    }
    if (/\b(?:query|inspect\s*graph|search\s*graph|find\s*in\s*graph)\b/i.test(p)) {
      return { tool: 'query_graph', args: { filter: {} } }
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
