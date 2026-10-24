/**
 * src/services/agentToolRegistry.ts
 * Single Source of Truth: Tool definitions, parameter validation schemas,
 * and Gemini LLM prompt generation for Cadence Copilot.
 */

export interface AgentToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'filter_catalog',
    description: 'Filters the active catalog view based on audio format, composer, language, era, or text query.',
    parameters: {
      type: 'object',
      properties: {
        composer: { type: 'string', description: 'Composer or primary artist name (e.g. "A. R. Rahman", "Beethoven")' },
        era: { type: 'string', description: 'Musical era bucket (e.g. "1970s", "1980s", "1990s")' },
        language: { type: 'string', description: 'Language taxonomy (e.g. "Tamil", "Hindi", "English")' },
        format: { type: 'string', enum: ['FLAC', 'DSD', 'WAV', 'ALAC', 'MP3', 'AIFF'] },
        genre: { type: 'string', description: 'Genre category' },
        mastering: { type: 'string', enum: ['high_res_24bit', 'standard_16bit', 'dsd_direct'] },
        searchQuery: { type: 'string', description: 'Free-form text search query' },
      },
    },
  },
  {
    name: 'switch_view',
    description: 'Switches the Data Canvas center stage workspace mode.',
    parameters: {
      type: 'object',
      properties: {
        viewMode: { type: 'string', enum: ['virtual_table', 'variant_stack', 'work_movement'] },
      },
      required: ['viewMode'],
    },
  },
  {
    name: 'run_audit',
    description: 'Triggers a comprehensive catalog hygiene and audio stream diagnostic scan.',
    parameters: {
      type: 'object',
      properties: {
        scopeTrackIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'remediate_issue',
    description: 'Applies automated 1-click remediation to catalog metadata anomalies.',
    parameters: {
      type: 'object',
      properties: {
        actionType: {
          type: 'string',
          enum: [
            'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER',
            'MERGE_DUPLICATE_PERFORMERS',
            'NORMALIZE_GENRES',
            'FETCH_HIRES_ART',
            'SYNC_FOLDER_TO_ALBUM',
            'REWORK_BACKDROP',
            'NORMALIZE_ARTIST_NAMES',
            'AUTOGEN_TRACK_NUMBERS',
            'FILL_MISSING_METADATA',
          ],
        },
        provider: { type: 'string', enum: ['apple', 'musicbrainz', 'ai'] },
        releaseId: { type: 'string' },
        targetName: { type: 'string' },
      },
      required: ['actionType'],
    },
  },
  {
    name: 'rework_backdrop',
    description: 'Generates and applies 2400x320 cinematic panoramic backdrops for Virtual Grid.',
    parameters: {
      type: 'object',
      properties: {
        composer: { type: 'string' },
        artist: { type: 'string' },
        releaseId: { type: 'string' },
        provider: { type: 'string', enum: ['apple', 'musicbrainz', 'ai'] },
      },
    },
  },
  {
    name: 'select_track',
    description: 'Locates and highlights a specific track by ID or title/artist query in the inspector.',
    parameters: {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'open_modal',
    description: 'Opens a dedicated management or commit dialog in Cadence.',
    parameters: {
      type: 'object',
      properties: {
        modalName: {
          type: 'string',
          enum: [
            'import',
            'commit',
            'path_rules',
            'batch_diff',
            'customize',
            'customize_album',
            'sidecar_export',
            'storage_manager',
            'quarantine_log',
          ],
        },
      },
      required: ['modalName'],
    },
  },
  {
    name: 'get_statistics',
    description: 'Retrieves current database metrics, dynamic range scores, format breakdown, and anomaly counts.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['full', 'filtered'] },
      },
    },
  },
  {
    name: 'reset_filters',
    description: 'Clears all active filters and search queries to display the entire music collection.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'stage_metadata',
    description: 'Stages non-destructive cover artwork or panoramic backdrops into track and release sidecars.',
    parameters: {
      type: 'object',
      properties: {
        coverArtUrl: { type: 'string' },
        backdropUrl: { type: 'string' },
        actionType: { type: 'string' },
        provider: { type: 'string', enum: ['apple', 'musicbrainz', 'ai'] },
      },
    },
  },
  {
    name: 'execute_pipeline',
    description: 'Executes an ordered sequential pipeline of tool operations with intermediate state tracking.',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: { type: 'object' },
              explanation: { type: 'string' },
            },
            required: ['tool', 'args'],
          },
        },
      },
      required: ['commands'],
    },
  },
  {
    name: 'resolve_work_hierarchy',
    description: 'Disentangles classical movements or complex Indian soundtrack titles into structured multi-performer & movement graph nodes.',
    parameters: {
      type: 'object',
      properties: {
        releaseId: { type: 'string' },
        query: { type: 'string' },
        strategy: { type: 'string', enum: ['classical_movement', 'soundtrack_performers', 'auto'] },
      },
    },
  },
  {
    name: 'compare_variant_pressings',
    description: 'Compares dynamic range, sample rate, bit depth, and duration across releases in a variant stack to recommend the primary master.',
    parameters: {
      type: 'object',
      properties: {
        releaseId: { type: 'string' },
        albumTitle: { type: 'string' },
      },
    },
  },
  {
    name: 'detect_transcode_anomalies',
    description: 'Inspects spectral frequency cutoffs (16kHz / 22kHz brickwall) to flag lossy MP3/CD transcodes masquerading as Hi-Res 24-bit.',
    parameters: {
      type: 'object',
      properties: {
        scopeTrackIds: { type: 'array', items: { type: 'string' } },
        thresholdKhz: { type: 'number' },
      },
    },
  },
  {
    name: 'synthesize_normalization_rule',
    description: 'Synthesizes and permanently registers a user-defined authority normalization rule into normalizationService for future imports.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Variant string to match (e.g. "Illayaraja")' },
        canonical: { type: 'string', description: 'Canonical authority target (e.g. "Ilaiyaraaja")' },
        category: { type: 'string', enum: ['artist', 'genre', 'composer'] },
      },
      required: ['pattern', 'canonical', 'category'],
    },
  },
  {
    name: 'preview_path_restructure',
    description: 'Generates a dry-run preview tree of physical directory and file restructuring according to dynamic path rules.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Naming template (e.g. "{Composer}/{Year} - {Album}/{TrackNum} - {Title}")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'curate_sonic_session',
    description: 'Assembles an audiophile playback queue based on dynamic range scores, high-res sample rates, and acoustic tags.',
    parameters: {
      type: 'object',
      properties: {
        minDrScore: { type: 'number', description: 'Minimum Dynamic Range score (e.g. 12 or 14)' },
        format: { type: 'string', enum: ['FLAC', 'DSD', 'WAV'] },
        durationMinutes: { type: 'number', description: 'Target session duration in minutes' },
      },
    },
  },
  {
    name: 'query_graph',
    description: 'Performs read-only inspection queries against the live graph engine for multi-attribute filtering and verification.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'object' },
        limit: { type: 'number' },
      },
      required: ['filter'],
    },
  },
]

export function generateGeminiSystemInstruction(catalogSummary: string): string {
  const toolsFormatted = AGENT_TOOL_DEFINITIONS.map(
    (t) => `- ${t.name}(args: ${JSON.stringify(t.parameters.properties)}): ${t.description}`
  ).join('\n')

  return `You are Cadence, an advanced autonomous AI musicologist, audio engineer, and library management agent embedded in Cadence Core (an audiophile-grade music management suite).
You have live access to the library database snapshot and can execute capabilities on the user's behalf.

${catalogSummary}

Available executable tools:
${toolsFormatted}

Instructions:
1. Provide a concise, knowledgeable, audiophile-grade conversational response in markdown.
2. If the user asks to perform an action (e.g. "filter to 24-bit tracks", "switch to grid", "auto tag from folders", "open commit modal"), include the exact structured tool in "command".
3. For compound or multi-step requests (e.g. "fetch art and rework backdrop", "run audit and fix tags, then commit", "filter to DSD and switch to grid"), use "execute_pipeline" with an ordered array of tool commands in "args.commands".
4. If the user asks for recommendations, evaluate the catalog hygiene and suggest the top 2-3 most impactful actions.
5. If the user asks an informational or explanatory question without requesting an action (e.g. "what is dynamic range?", "how many tracks do I have?", "why is bit-rot dangerous?"), answer conversationally and set "command" to null.
6. Format output strictly as JSON with this schema:
{
  "response": "<Markdown formatted conversational response>",
  "command": { "tool": "<tool_name>", "args": { ... }, "explanation": "<short description of action>" } | null,
  "suggestedActions": [ { "label": "<short pill label>", "prompt": "<full instruction>" } ]
}`
}
