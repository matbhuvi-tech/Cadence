import { Track, Release, Work } from './types'
import { graphEngine } from './graphEngine'

export interface PathRestructurePreview {
  trackId: string
  currentPath: string
  proposedPath: string
  isChanged: boolean
  hasCollision: boolean
}

export class TemplateEngine {
  /**
   * Default audiophile template supporting classical work-movement branching and standard pop/jazz albums.
   */
  public static readonly DEFAULT_TEMPLATE =
    '{%if classical%}{composer}/{work}/{release_year} - {release_title} [{format}]/{movement_num} - {movement_title}.{ext}{%else%}{artist}/{album_year} - {album}/{track_num:2} - {track_title}.{ext}{%endif%}'

  /**
   * Sanitizes string for filesystem paths (removing forbidden characters across OSs).
   */
  private sanitize(val: string): string {
    return val
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Evaluates template string for a specific track, release, and work context.
   */
  public evaluateTemplate(template: string, track: Track, release?: Release, work?: Work): string {
    const isClassical =
      Boolean(work && (work.composerName || work.isMultiPart)) ||
      Boolean(track.workTitle || (track.composerName && !track.artistCredit.includes(track.composerName)))

    // Extract conditional branches {%if classical%} ... {%else%} ... {%endif%}
    let compiled = template
    const ifRegex = /\{%if\s+classical%\}([\s\S]*?)\{%else%\}([\s\S]*?)\{%endif%\}/gi
    compiled = compiled.replace(ifRegex, (_, ifBranch, elseBranch) => {
      return isClassical ? ifBranch : elseBranch
    })

    const ext = track.filePath.split('.').pop() || 'flac'
    const padNum = (num: number, digits: number = 2) => String(num).padStart(digits, '0')

    const tokens: Record<string, string> = {
      '{composer}': this.sanitize(track.composerName || work?.composerName || 'Unknown Composer'),
      '{work}': this.sanitize(track.workTitle || work?.title || 'Unknown Work'),
      '{movement_num}': this.sanitize(track.movementNumber || 'I'),
      '{movement_title}': this.sanitize(track.movementTitle || track.title),
      '{release_year}': String(release?.releaseYear || 1900),
      '{release_title}': this.sanitize(release?.title || 'Unknown Album'),
      '{format}': this.sanitize(track.format),
      '{artist}': this.sanitize(track.artistCredit || 'Unknown Artist'),
      '{album_year}': String(release?.releaseYear || 1900),
      '{album}': this.sanitize(release?.title || 'Unknown Album'),
      '{folder}': this.sanitize(release?.folderName || 'Unknown Folder'),
      '{folder_name}': this.sanitize(release?.folderName || 'Unknown Folder'),
      '{track_num:2}': padNum(track.trackNumber, 2),
      '{track_num}': String(track.trackNumber),
      '{track_title}': this.sanitize(track.title),
      '{ext}': ext,
    }

    let result = compiled
    for (const [token, val] of Object.entries(tokens)) {
      result = result.split(token).join(val)
    }

    return result.replace(/\/+/g, '/')
  }

  /**
   * Generates a full preview of directory restructuring across selected tracks.
   */
  public generateRestructurePreview(
    tracks: Track[],
    template: string = TemplateEngine.DEFAULT_TEMPLATE,
    baseMountPath: string = '/mnt/audiophile-nas/lossless'
  ): PathRestructurePreview[] {
    const seenPaths = new Set<string>()

    return tracks.map((track) => {
      const release = graphEngine.getReleaseById(track.releaseId)
      const work = track.workId ? graphEngine.getWorkById(track.workId) : undefined
      const relativePath = this.evaluateTemplate(template, track, release, work)
      const proposedPath = `${baseMountPath}/${relativePath}`
      const isChanged = proposedPath !== track.filePath
      const hasCollision = seenPaths.has(proposedPath)
      seenPaths.add(proposedPath)

      return {
        trackId: track.id,
        currentPath: track.filePath,
        proposedPath,
        isChanged,
        hasCollision,
      }
    })
  }
}

export const templateEngine = new TemplateEngine()
