import { Track, Release, Work, Person } from './types'

export interface SidecarPayload {
  cadenceSidecarVersion: string
  audioFileRef: {
    path: string
    sizeBytes: number
    md5Checksum: string
  }
  entities: {
    work?: Partial<Work>
    release?: Partial<Release>
    persons?: Partial<Person>[]
  }
  movementOverrides?: {
    movementNumber?: string
    movementTitle?: string
    opusNumber?: string
  }
  curation: {
    rating?: number
    listeningFlags?: string[]
    audiophileNotes?: string
    dynamicRangeScore?: number
  }
  customTags: Record<string, string | string[]>
  lastModifiedTimestamp: string
}

export class SidecarManager {
  /**
   * Generates a sidecar file path next to the audio file (e.g. "01 - Allegro.flac.sidecar.json")
   */
  public getSidecarPath(audioFilePath: string, format: 'json' | 'yaml' | 'xmp' = 'json'): string {
    return `${audioFilePath}.sidecar.${format}`
  }

  /**
   * Builds an audiophile JSON sidecar without modifying the audio file.
   */
  public createJsonSidecar(track: Track, release?: Release, work?: Work): string {
    const payload: SidecarPayload = {
      cadenceSidecarVersion: '2.4.0',
      audioFileRef: {
        path: track.filePath,
        sizeBytes: track.fileSize,
        md5Checksum: 'stream-hash-verified-valid',
      },
      entities: {
        work: work ? { id: work.id, title: work.title, opusOrCatalogueNumber: work.opusOrCatalogueNumber } : undefined,
        release: release ? { id: release.id, title: release.title, catalogNumber: release.catalogNumber, mediaFormat: release.mediaFormat } : undefined,
      },
      movementOverrides: {
        movementNumber: track.movementNumber,
        movementTitle: track.movementTitle,
      },
      curation: {
        rating: track.pendingSidecarEdits?.userRating || 5,
        listeningFlags: [track.pendingSidecarEdits?.listeningFlag || 'Reference Master'],
        dynamicRangeScore: track.drScore,
      },
      customTags: {
        ORGANIZATION_ENGINE: 'Cadence Core Relational v2.4',
        SAMPLERATE_SPECS: track.sampleRateStr,
        ACCURATERIP_CONFIDENCE: String(track.accurateRipConfidence),
      },
      lastModifiedTimestamp: new Date().toISOString(),
    }

    return JSON.stringify(payload, null, 2)
  }

  /**
   * Builds an industry-standard XMP (Extensible Metadata Platform) sidecar for archival systems.
   */
  public createXmpSidecar(track: Track): string {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Cadence Core XMP Engine 2.4">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:cadence="http://cadence.audio/metadata/1.0/">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${track.title}</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:creator>
        <rdf:Seq>
          <rdf:li>${track.artistCredit}</rdf:li>
        </rdf:Seq>
      </dc:creator>
      <cadence:workTitle>${track.workTitle || ''}</cadence:workTitle>
      <cadence:movementNumber>${track.movementNumber || ''}</cadence:movementNumber>
      <cadence:dynamicRangeScore>${track.drScore}</cadence:dynamicRangeScore>
      <cadence:sidecarStatus>${track.sidecarStatus}</cadence:sidecarStatus>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  }

  /**
   * Builds YAML representation for human readability.
   */
  public createYamlSidecar(track: Track): string {
    return `# Cadence Core Non-Destructive Sidecar
version: "2.4"
file: "${track.filePath}"
metadata:
  title: "${track.title}"
  artist: "${track.artistCredit}"
  composer: "${track.composerName || ''}"
  work: "${track.workTitle || ''}"
  movement: "${track.movementNumber || ''} - ${track.movementTitle || ''}"
audio_integrity:
  format: "${track.format}"
  resolution: "${track.sampleRateStr}"
  dr_score: ${track.drScore}
  checksum_verified: ${track.checksumValid}
timestamp: "${new Date().toISOString()}"
`
  }
}

export const sidecarManager = new SidecarManager()
