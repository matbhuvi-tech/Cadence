export type TutorialCategory =
  | 'HEADER'
  | 'LEFT_RAIL_TAXONOMY'
  | 'LEFT_RAIL_FILTERS'
  | 'LEFT_RAIL_STORAGE'
  | 'CANVAS_TOOLBAR'
  | 'WORK_MOVEMENT_VIEW'
  | 'VARIANT_STACKS_VIEW'
  | 'VIRTUAL_GRID_VIEW'
  | 'RIGHT_PANEL_CREDITS'
  | 'RIGHT_PANEL_DIFF'
  | 'RIGHT_PANEL_ARTWORK'
  | 'RIGHT_PANEL_INTEGRITY'
  | 'MODALS'

export interface AgentProtocol {
  selector: string
  interactionType: 'click' | 'input' | 'toggle' | 'select' | 'inspect'
  apiEndpoints: string[]
  dataModelMutation: string
  keyboardShortcut?: string
}

export interface TutorialActions {
  setViewMode: (mode: 'work_movement' | 'variant_stack' | 'virtual_table') => void
  setAlbumDisplayMode: (mode: 'album_first' | 'folder_first' | 'both') => void
  setRightPanelTab: (tab: 'credits' | 'diff' | 'artwork' | 'integrity') => void
  openImportModal: () => void
  closeImportModal: () => void
  openCommitModal: () => void
  closeCommitModal: () => void
  openBatchRuleModal: () => void
  closeBatchRuleModal: () => void
  openBatchAiModal: () => void
  closeBatchAiModal: () => void
  openBatchDiffModal?: () => void
  closeBatchDiffModal?: () => void
  openCustomizeModal: () => void
  closeCustomizeModal: () => void
  openCommandBar: () => void
  closeCommandBar: () => void
  selectTrack: (trackId?: string) => void
  selectTracks: (trackIds: string[]) => void
}

export interface TutorialStep {
  id: string
  category: TutorialCategory
  categoryLabel: string
  targetSelector: string
  title: string
  role: string
  humanExplanation: string
  agentProtocol: AgentProtocol
  contextTransition?: (actions: TutorialActions) => void
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  // ==========================================
  // 1. MASTER HEADER & TOP-LEVEL METRICS
  // ==========================================
  {
    id: 'header-brand',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-brand"]',
    title: 'CADENCE CORE Identity & Engine Brand',
    role: 'Root application identifier representing the relational music cataloging engine.',
    humanExplanation:
      'Cadence Core is a specialized, bit-perfect relational audio management engine built for classical, high-resolution audiophile, and archival music collections. Unlike flat taggers, Cadence maintains true multi-tiered relational hierarchies across Compositions, Movements, Master Releases, Pressing Variants, and Physical Audio Streams.',
    agentProtocol: {
      selector: '[data-tutorial-id="header-brand"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'None (Informational banner).',
    },
    contextTransition: (a) => {
      a.closeCommitModal()
      a.closeImportModal()
      a.closeBatchAiModal()
      a.closeBatchRuleModal()
    },
  },
  {
    id: 'header-status-pill',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-status-pill"]',
    title: 'Active Library State Indicator',
    role: 'Displays whether the system is browsing the demo catalog or an imported personal audio library.',
    humanExplanation:
      'Displays the active catalog scope (e.g. "Personal Library (1,280 tracks)" or "Demo Catalog · 6 Masters"). When a custom directory (local disk or network SMB share) is scanned, this badge lights up in green, indicating that all modifications and sidecar metadata operate against real physical files rather than demo seed memory.',
    agentProtocol: {
      selector: '[data-tutorial-id="header-status-pill"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Reflects graphEngine.isUsingCustomLibrary() and IndexedDB CadenceCoreDB state.',
    },
  },
  {
    id: 'header-highres-pill',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-highres-pill"]',
    title: 'Audiophile High-Res Fidelity Gauge',
    role: 'Calculates the real-time percentage of tracks meeting 24-bit/96kHz+ or DSD master standards.',
    humanExplanation:
      'Computes the dynamic ratio of high-resolution master audio files in your library. Files classified as High-Res include 24-bit PCM (FLAC, WAV, ALAC, AIFF at 88.2kHz, 96kHz, 192kHz, 384kHz, DXD) and native DSD streams (DSD64, DSD128, DSD256, DSD512, DSD1024). Redbook 16-bit/44.1kHz and lossy files are accurately segregated.',
    agentProtocol: {
      selector: '[data-tutorial-id="header-highres-pill"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Derived from graphEngine.getStats().highResPercentage.',
    },
  },
  {
    id: 'header-dr-pill',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-dr-pill"]',
    title: 'Average Dynamic Range (DR) Metric',
    role: 'Displays the catalog-wide average Dynamic Range score on the Pleasurize Music Foundation scale (DR1 to DR20).',
    humanExplanation:
      'Dynamic Range (DR) is the definitive audiophile metric measuring uncompressed acoustic headroom and micro-dynamics. High scores (DR12 to DR18) signify pristine mastering without loudness-war brickwall limiting. Cadence calculates DR directly from embedded ReplayGain tags, R128 loudness atoms, or real acoustic stream peak-to-loudness ratio (PLR).',
    agentProtocol: {
      selector: '[data-tutorial-id="header-dr-pill"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Derived from graphEngine.getStats().averageDrScore.',
    },
  },
  {
    id: 'header-ro-pill',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-ro-pill"]',
    title: 'Read-Only Storage Mount Locks Counter',
    role: 'Shows how many physical drives or NAS shares are currently write-locked against physical alterations.',
    humanExplanation:
      'When managing immutable archival storage (such as read-only NAS volumes, ZFS snapshots, or master backup drives), engaging a Read-Only Lock prevents accidental tag modifications, deletions, or disk writes. This badge reflects the number of protected storage mounts active in the session.',
    agentProtocol: {
      selector: '[data-tutorial-id="header-ro-pill"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Counts StorageMount.isReadOnlyLocked === true in graphEngine.',
    },
  },
  {
    id: 'header-staged-sidecars-pill',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="header-staged-sidecars-pill"]',
    title: 'Staged Sidecars Quick-Trigger Pill',
    role: 'Alerts the user to pending uncommitted sidecar modifications and opens the Staged for Commit modal.',
    humanExplanation:
      'Whenever you perform selective metadata merges, AI track resolutions, album customizations, or batch spreadsheet edits, changes are staged in non-destructive sidecars without modifying master audio files. This pulsating amber badge displays the number of pending tracks. Clicking it directly launches the 2-Phase Safe Commit dialog.',
    agentProtocol: {
      selector: '[data-tutorial-id="header-staged-sidecars-pill"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Filters tracks by sidecarStatus === "uncommitted_sidecar" and opens TwoPhaseCommitModal.',
    },
  },
  {
    id: 'btn-import-library',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="btn-import-library"]',
    title: 'Import Your Library Button (⌘O)',
    role: 'Opens the High-Performance Local & Network SMB Directory Ingestion Modal.',
    humanExplanation:
      'Launches the directory scanner. You can enter any local disk path (e.g. "C:\\Music\\Classical") or network SMB share path (e.g. "\\\\NAS\\Music Collection\\Master\\Classical"). The backend runs a high-throughput, multi-threaded SSE streaming scan that extracts metadata, detects ZFS/NTFS storage stats, and parses existing .sidecar.json files on disk.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-import-library"]',
      interactionType: 'click',
      apiEndpoints: ['/api/scan-stream', '/api/scan-local-dir'],
      dataModelMutation: 'Invokes libraryImporter.importFromLocalPath and updates graphEngine with scanned entities.',
      keyboardShortcut: '⌘O',
    },
  },
  {
    id: 'btn-spotlight-cmd',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="btn-spotlight-cmd"]',
    title: 'Omni Spotlight Command Bar (⌘K)',
    role: 'Opens the global keyboard-driven command palette for instant navigation, filtering, and operational macros.',
    humanExplanation:
      'Provides instant keyboard-driven search and execution across the entire suite. You can filter actions, switch view modes (1, 2, 3), launch the Guided Tutorial, open the Staged for Commit modal, trigger Batch Diff, or execute path templating without touching the mouse.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-spotlight-cmd"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Opens OmniCommandBar modal with fuzzy command index.',
      keyboardShortcut: '⌘K',
    },
  },
  {
    id: 'btn-guided-tutorial',
    category: 'HEADER',
    categoryLabel: 'Master Navigation Header',
    targetSelector: '[data-tutorial-id="btn-guided-tutorial"]',
    title: 'Guided Tutorial Button (?)',
    role: 'Starts or resumes the exhaustive interactive system tour for human operators and headless automation agents.',
    humanExplanation:
      'Launches this guided tutorial system! It provides spotlight focus, smooth viewport navigation, and dual-mode documentation (Human Walkthrough vs. Headless Agent JSON Protocol) covering every single filter, button, option, and modal in Cadence Core.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-guided-tutorial"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Toggles window.__CADENCE_TUTORIAL__ and opens GuidedTutorialModal.',
      keyboardShortcut: '?',
    },
  },

  // ==========================================
  // 2. LEFT RAIL: TAXONOMY, AUDIT & STORAGE
  // ==========================================
  {
    id: 'left-rail-taxonomy-banner',
    category: 'LEFT_RAIL_TAXONOMY',
    categoryLabel: 'Left Rail: Relational Taxonomy',
    targetSelector: '[data-tutorial-id="left-rail-taxonomy-banner"]',
    title: 'Dynamic Taxonomy Tree Header',
    role: 'Section header anchoring the Left Rail taxonomy, health triage queue, and multi-dimensional faceted filters.',
    humanExplanation:
      'The Left Rail manages relational taxonomies and collection hygiene. It separates your audio assets into dynamic triage queues (for errors and inconsistencies), multi-dimensional acoustic facets (format, era, mastering quality, genre), and physical storage mount topologies.',
    agentProtocol: {
      selector: '[data-tutorial-id="left-rail-taxonomy-banner"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'None.',
    },
  },
  {
    id: 'audit-triage-panel',
    category: 'LEFT_RAIL_TAXONOMY',
    categoryLabel: 'Left Rail: Health & Triage Queue',
    targetSelector: '[data-tutorial-id="audit-triage-panel"]',
    title: 'Catalog Health & Hygiene Audit Panel',
    role: 'Automated diagnostic engine detecting bit-rot, metadata anomalies, and artwork defects.',
    humanExplanation:
      'Continuously audits your library against strict audiophile curation rules. It highlights anomalies such as: Inconsistent Artist Name Variants, FLAC Stream Bit-Rot (CRC mismatch), Low-Resolution Cover Art (< 800px), Missing Movement Sequence Numbers, and AcoustID Unlinked Files.',
    agentProtocol: {
      selector: '[data-tutorial-id="audit-triage-panel"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Backed by auditService.runFullCatalogAudit() and graphEngine.getAllAuditIssues().',
    },
  },
  {
    id: 'audit-issue-item',
    category: 'LEFT_RAIL_TAXONOMY',
    categoryLabel: 'Left Rail: Health & Triage Queue',
    targetSelector: '[data-tutorial-id="audit-issue-item"]',
    title: 'Audit Issue Triage Item',
    role: 'Individual diagnostic card indicating issue category, severity badge, and affected track count.',
    humanExplanation:
      'Each issue card displays a severity badge (Critical in Red, Warning in Amber, Info in Blue). Clicking an issue card applies a live Triage Filter to the Virtual Grid, instantly isolating the exact audio tracks affected by the diagnostic anomaly.',
    agentProtocol: {
      selector: '[data-tutorial-id="audit-issue-item"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets activeTriageFilter to issue.id, filtering tracks in DataCanvas.',
    },
  },
  {
    id: 'audit-remediate-btn',
    category: 'LEFT_RAIL_TAXONOMY',
    categoryLabel: 'Left Rail: Health & Triage Queue',
    targetSelector: '[data-tutorial-id="audit-remediate-btn"]',
    title: '1-Click Auto-Remediation Button',
    role: 'Instantly applies rule-based automated hygiene repairs (e.g. normalizing artist credits or fixing tags).',
    humanExplanation:
      'Clicking "Remediate" or "Fix" executes an atomic rule repair on all affected entities. For example, it normalizes disparate spelling variations (e.g. "A.R. Rahman" vs "A. R. Rahman") to the canonical authority, stages changes in sidecars, and syncs to IndexedDB.',
    agentProtocol: {
      selector: '[data-tutorial-id="audit-remediate-btn"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Calls auditService.remediateIssue(issueId) and stages sidecars in graphEngine.',
    },
  },
  {
    id: 'faceted-filters-container',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="faceted-filters-container"]',
    title: 'Multi-Dimensional Faceted Filter Engine',
    role: 'Cross-dimensional filtering matrix across physical format, historical era, mastering type, and genre.',
    humanExplanation:
      'Allows multi-dimensional acoustic slice-and-dice of your catalog. Unlike simple text queries, facets allow compound filtering: for instance, selecting "DSD" + "1970-1989" + "Tape -> DSD Transfer" + "Jazz" filters the catalog down to pure analog master tape transfers from the 70s.',
    agentProtocol: {
      selector: '[data-tutorial-id="faceted-filters-container"]',
      interactionType: 'select',
      apiEndpoints: [],
      dataModelMutation: 'Updates FacetSelections state passed into graphEngine.filterTracks(facetState).',
    },
  },
  {
    id: 'filter-era-pills',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="filter-era-pills"]',
    title: 'Recording Era Filter Selector',
    role: 'Filters recordings by chronological recording decade: Earlier - 1970, 1971 - 1980, 1981 - 1990, 1991 - 2000, 2001 - 2010, 2010 - Present.',
    humanExplanation:
      'Segments recordings into historical mastering epochs. Filter by Earlier - 1970 for analog golden age stereo and mono masters, 1971 - 1980 for 70s peak analog tape albums, 1981 - 1990 for early digital CDs and 80s soundtracks, 1991 - 2000, 2001 - 2010, or 2010 - Present for contemporary high-resolution releases.',
    agentProtocol: {
      selector: '[data-tutorial-id="filter-era-pills"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets facets.era to era bucket ("earlier-1970" | "1971-1980" | "1981-1990" | "1991-2000" | "2001-2010" | "2010-present").',
    },
  },
  {
    id: 'filter-composer-pills',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="filter-composer-pills"]',
    title: 'Composer Authority Filter Selector',
    role: 'Filters recordings by canonical composer authorities (e.g. A. R. Rahman, Ilaiyaraaja, M.S.V, Beethoven).',
    humanExplanation:
      'Dynamically identifies and groups all composers across your collection with canonical authority deduplication. Selecting a composer isolates all compositions, soundtracks, and works scored by that composer regardless of slight naming variations.',
    agentProtocol: {
      selector: '[data-tutorial-id="filter-composer-pills"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets facets.composer to canonical composer key, filtering tracks by composer credit.',
    },
  },
  {
    id: 'filter-language-pills',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="filter-language-pills"]',
    title: 'Repertoire Language Filter Selector',
    role: 'Filters library by vocal/cultural language: Tamil, Hindi, English, Malayalam.',
    humanExplanation:
      'Isolates tracks by linguistic repertoire (Tamil, Hindi, English, Malayalam). Language is derived from explicit tags, Unicode script analysis (Tamil, Devanagari, Malayalam), and catalog heuristics.',
    agentProtocol: {
      selector: '[data-tutorial-id="filter-language-pills"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets facets.language to "Tamil" | "Hindi" | "English" | "Malayalam".',
    },
  },
  {
    id: 'filter-format-pills',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="filter-format-pills"]',
    title: 'Resolution & Format Filter Selector',
    role: 'Filters recordings by physical container and DSD clock tier: WAV, MP3, FLAC, DSD256, DSD512.',
    humanExplanation:
      'Allows precise audio container and bit-clock filtering: WAV (Linear PCM), MP3 (Audio), FLAC (Lossless), DSD256 (11.3MHz Direct Stream Digital), and DSD512 (22.6MHz Direct Stream Digital).',
    agentProtocol: {
      selector: '[data-tutorial-id="filter-format-pills"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets facets.format to "WAV" | "MP3" | "FLAC" | "DSD256" | "DSD512".',
    },
  },
  {
    id: 'filter-reset-btn',
    category: 'LEFT_RAIL_FILTERS',
    categoryLabel: 'Left Rail: Faceted Filtering',
    targetSelector: '[data-tutorial-id="filter-reset-btn"]',
    title: 'Reset All Facet Filters Button',
    role: 'Clears all active facet selections, restoring 100% full visibility of the active library.',
    humanExplanation:
      'When active filters result in zero or limited matching tracks, clicking "Reset Facets" clears all format, era, mastering, and genre restrictions in a single click.',
    agentProtocol: {
      selector: '[data-tutorial-id="filter-reset-btn"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Clears facets to {}, restoring full track set.',
    },
  },
  {
    id: 'storage-mounts-container',
    category: 'LEFT_RAIL_STORAGE',
    categoryLabel: 'Left Rail: Storage Mounts',
    targetSelector: '[data-tutorial-id="storage-mounts-container"]',
    title: 'Physical Storage Mounts & NAS Topology',
    role: 'Displays physical volumes, disk space utilization, filesystem types (ZFS/NTFS), and drive health.',
    humanExplanation:
      'Shows all physical storage locations mounted by Cadence. Each mount card reports the drive letter or network UNC path, storage usage gauge, drive filesystem (ZFS, NTFS, APFS), temperature, and SMART health diagnostics.',
    agentProtocol: {
      selector: '[data-tutorial-id="storage-mounts-container"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Reads graphEngine.getAllStorageMounts().',
    },
  },
  {
    id: 'storage-ro-toggle',
    category: 'LEFT_RAIL_STORAGE',
    categoryLabel: 'Left Rail: Storage Mounts',
    targetSelector: '[data-tutorial-id="storage-ro-toggle"]',
    title: 'Storage Mount Read-Only Lock Switch',
    role: 'Hardware/software write safety interlock preventing file header modifications on archival drives.',
    humanExplanation:
      'Toggling this switch engages or disengages the Read-Only Safety Lock for that mount. When locked, any commit attempt targeting files on this mount is blocked by the 2-Phase Commit transaction engine to guarantee zero risk of data mutation on master archives.',
    agentProtocol: {
      selector: '[data-tutorial-id="storage-ro-toggle"]',
      interactionType: 'toggle',
      apiEndpoints: [],
      dataModelMutation: 'Calls graphEngine.toggleMountReadOnly(mountId) flipping StorageMount.isReadOnlyLocked.',
    },
  },

  // ==========================================
  // 3. CENTER STAGE: DATA CANVAS & TOOLBAR
  // ==========================================
  {
    id: 'btn-view-work-movement',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-view-work-movement"]',
    title: 'Work / Movement Hierarchy View Button (1)',
    role: 'Switches the Data Canvas to the Classical Multi-Movement Composition Tree.',
    humanExplanation:
      'Switches the canvas to hierarchical classical view. Instead of treating every file as an isolated pop song, this mode groups recordings under parent multi-part Works (e.g. Beethoven Symphony No. 5 in C minor, Op. 67), displaying sequential movements (I. Allegro con brio, II. Andante con moto) in order.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-view-work-movement"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets CanvasViewMode to "work_movement".',
      keyboardShortcut: '1',
    },
    contextTransition: (a) => a.setViewMode('work_movement'),
  },
  {
    id: 'btn-view-variant-stacks',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-view-variant-stacks"]',
    title: 'Variant & Master Pressing Stacks View Button (2)',
    role: 'Switches the Data Canvas to the Audiophile Release & Pressing Editions Stack.',
    humanExplanation:
      'Switches the canvas to Variant Stacks mode. Classical and jazz audiophiles frequently own 5+ different master pressings of the same album (e.g. Kind of Blue 1959 6-Eye Mono, 1986 Japan CD, 2013 Analogue Productions DSD128, 2024 PGGB 32-bit/768kHz). This view stacks them neatly under one release card.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-view-variant-stacks"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets CanvasViewMode to "variant_stack".',
      keyboardShortcut: '2',
    },
    contextTransition: (a) => a.setViewMode('variant_stack'),
  },
  {
    id: 'btn-view-virtual-grid',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-view-virtual-grid"]',
    title: 'Ultra-Fast Virtual Data Grid View Button (3)',
    role: 'Switches the Data Canvas to the 60FPS Virtualized Spreadsheet Table.',
    humanExplanation:
      'Switches to the ultra-fast virtualized data table. Capable of rendering 50,000+ tracks smoothly at 60 FPS. It supports multi-row checkbox selections, keyboard navigation, spreadsheet multi-editing (Alt+E), batch diff resolution, and row-level sidecar inspections.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-view-virtual-grid"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets CanvasViewMode to "virtual_table".',
      keyboardShortcut: '3',
    },
    contextTransition: (a) => a.setViewMode('virtual_table'),
  },
  {
    id: 'canvas-search-input',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="canvas-search-input"]',
    title: 'Real-Time Relational Search Input',
    role: 'Instant multi-field fuzzy search across titles, composers, catalog numbers, and matrix runouts.',
    humanExplanation:
      'Type to search instantly across all relational fields simultaneously: Track Title, Work Title, Composer Name, Artist Credit, Opus Number, Matrix Runout, or Catalog Number. Debounced for instant responsiveness even across massive collections.',
    agentProtocol: {
      selector: '[data-tutorial-id="canvas-search-input"]',
      interactionType: 'input',
      apiEndpoints: [],
      dataModelMutation: 'Updates searchQuery state, re-filtering tracks via graphEngine.',
    },
  },
  {
    id: 'btn-display-album-first',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-display-album-first"]',
    title: 'Display Mode: "Album First" Toggle',
    role: 'Sets the visual hierarchy to prioritize official metadata Album Title over directory names.',
    humanExplanation:
      'Configures how release cards and grid rows display naming. In "Album First" mode, the canonical album title (e.g. "Abbey Road [2019 Super Deluxe]") is rendered prominently as the primary heading, with the physical folder name displayed as a subtitle badge.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-display-album-first"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets albumDisplayMode to "album_first".',
    },
    contextTransition: (a) => a.setAlbumDisplayMode('album_first'),
  },
  {
    id: 'btn-display-folder-first',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-display-folder-first"]',
    title: 'Display Mode: "Folder First" Toggle',
    role: 'Sets the visual hierarchy to prioritize physical directory folder names over metadata tags.',
    humanExplanation:
      'Prioritizes the actual folder name on disk (e.g. "1969 - Abbey Road (UK 1st Press Vinyl 24-96)"). Ideal for collectors whose physical disk folder structure reflects exact rip provenance that differs from commercial CD album tags.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-display-folder-first"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets albumDisplayMode to "folder_first".',
    },
    contextTransition: (a) => a.setAlbumDisplayMode('folder_first'),
  },
  {
    id: 'btn-toolbar-path-rules',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-toolbar-path-rules"]',
    title: 'Path Rules & Restructuring Button',
    role: 'Opens the dynamic rule-based file and directory renaming template engine.',
    humanExplanation:
      'Launches the Path Rules Modal. Cadence features a conditional branching path template engine: Classical works branch into {Composer}/{Work}/{Year - Release}/{MovementNumber - Title}.flac, while Contemporary releases branch into {Artist}/{Album}/{TrackNumber - Title}.flac.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-toolbar-path-rules"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Opens BatchRuleModal to preview and stage path reorganizations.',
    },
  },
  {
    id: 'btn-toolbar-staged-commit',
    category: 'CANVAS_TOOLBAR',
    categoryLabel: 'Center Stage Toolbar',
    targetSelector: '[data-tutorial-id="btn-toolbar-staged-commit"]',
    title: 'Staged for Commit Button (2-Phase Safety)',
    role: 'Opens the Staged for Commit Modal to review before ➔ after diffs and execute atomic 2-phase commits.',
    humanExplanation:
      'Displays the total count of tracks with pending sidecar modifications. Clicking opens the 2-Phase Safe Commit Modal where you can inspect comprehensive diffs, view transaction pipeline stages, write bit-perfect .sidecar.json files to disk, and execute atomic rollbacks.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-toolbar-staged-commit"]',
      interactionType: 'click',
      apiEndpoints: ['/api/commit-tags'],
      dataModelMutation: 'Opens TwoPhaseCommitModal to write sidecars and persist to IndexedDB.',
    },
  },

  // ==========================================
  // 4. VIEW 1: CLASSICAL WORK / MOVEMENT VIEW
  // ==========================================
  {
    id: 'work-card-container',
    category: 'WORK_MOVEMENT_VIEW',
    categoryLabel: 'View Mode: Work / Movement Tree',
    targetSelector: '[data-tutorial-id="work-card-container"]',
    title: 'Classical Work Composition Card',
    role: 'Parent container grouping all sequential movements under a canonical musical work.',
    humanExplanation:
      'Represents the musical composition as an overarching entity. It displays canonical work titles (e.g. "Symphony No. 5 in C minor, Op. 67"), Composer sort authority ("Ludwig van Beethoven"), opus/catalogue numbers, and composition year.',
    agentProtocol: {
      selector: '[data-tutorial-id="work-card-container"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Renders Work object from graphEngine.getAllWorks().',
    },
    contextTransition: (a) => a.setViewMode('work_movement'),
  },
  {
    id: 'work-movement-row',
    category: 'WORK_MOVEMENT_VIEW',
    categoryLabel: 'View Mode: Work / Movement Tree',
    targetSelector: '[data-tutorial-id="work-movement-row"]',
    title: 'Movement Track Row & Audio Specs',
    role: 'Individual movement within a classical work, displaying sequence badge, tempo, DR score, and audio specs.',
    humanExplanation:
      'Displays each constituent movement in order: Roman numeral sequence ("I", "II", "III"), movement tempo/title ("Allegro con brio"), duration, bit-depth/sample-rate pill, and real Dynamic Range score. Clicking any row selects the track and inspects it in the Right Panel.',
    agentProtocol: {
      selector: '[data-tutorial-id="work-movement-row"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Calls onSelectTrack(trackId), updating selectedTrackId.',
    },
    contextTransition: (a) => a.setViewMode('work_movement'),
  },

  // ==========================================
  // 5. VIEW 2: VARIANT & MASTER PRESSING STACKS
  // ==========================================
  {
    id: 'variant-master-card',
    category: 'VARIANT_STACKS_VIEW',
    categoryLabel: 'View Mode: Variant Stacks',
    targetSelector: '[data-tutorial-id="variant-master-card"]',
    title: 'Master Release Card & High-Res Cover Art',
    role: 'Container grouping multiple physical master pressings and mastering variants under a single title.',
    humanExplanation:
      'Houses the master release title, artist credit, release year, label, and high-resolution front cover artwork. It groups all physical pressing variants of this release into an expandable stack, preventing collection clutter.',
    agentProtocol: {
      selector: '[data-tutorial-id="variant-master-card"]',
      interactionType: 'inspect',
      apiEndpoints: ['/api/track-art'],
      dataModelMutation: 'Renders Release object from graphEngine.getAllReleases().',
    },
    contextTransition: (a) => a.setViewMode('variant_stack'),
  },
  {
    id: 'btn-customize-album-folder',
    category: 'VARIANT_STACKS_VIEW',
    categoryLabel: 'View Mode: Variant Stacks',
    targetSelector: '[data-tutorial-id="btn-customize-album-folder"]',
    title: 'Customize Album & Folder Name Button',
    role: 'Opens the modal to customize and decouple metadata Album Title vs physical on-disk Folder Name.',
    humanExplanation:
      'Allows you to customize the Album Title and physical directory Folder Name independently. When saved, Cadence stages non-destructive sidecars for all tracks in that album, writes cadence-album.sidecar.json, and persists the customization directly to IndexedDB.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-customize-album-folder"]',
      interactionType: 'click',
      apiEndpoints: ['/api/commit-tags'],
      dataModelMutation: 'Calls graphEngine.updateReleaseNames(releaseId, { title, folderName }) and persistCurrentLibrary().',
    },
    contextTransition: (a) => a.setViewMode('variant_stack'),
  },
  {
    id: 'variant-item-row',
    category: 'VARIANT_STACKS_VIEW',
    categoryLabel: 'View Mode: Variant Stacks',
    targetSelector: '[data-tutorial-id="variant-item-row"]',
    title: 'Pressing Variant Row & Matrix Runout Details',
    role: 'Detailed card for a specific pressing variant with catalog number, mastering lineage, and matrix etchings.',
    humanExplanation:
      'Shows the specific details of a pressing variant: e.g. "1959 US Columbia 6-Eye First Press Mono Vinyl", DR14 score, matrix runout string ("XSM47326-1AJ"), label, and format. Star icon designates the active "Master Edition" used for playback and export.',
    agentProtocol: {
      selector: '[data-tutorial-id="variant-item-row"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Calls onSelectVariant(releaseId, variantId), updating Release.variants isCurrentMaster.',
    },
    contextTransition: (a) => a.setViewMode('variant_stack'),
  },

  // ==========================================
  // 6. VIEW 3: VIRTUAL DATA GRID & BATCH ACTIONS
  // ==========================================
  {
    id: 'virtual-grid-select-all',
    category: 'VIRTUAL_GRID_VIEW',
    categoryLabel: 'View Mode: Virtual Data Grid',
    targetSelector: '[data-tutorial-id="virtual-grid-select-all"]',
    title: 'Grid Multi-Select Checkbox Header',
    role: 'Toggles batch selection across all currently filtered tracks in the Virtual Data Grid.',
    humanExplanation:
      'Master checkbox in the table header. Clicking toggles selection across all filtered tracks in the view. Selected tracks can be multi-edited in spreadsheet mode or batched into Gemini AI metadata queries.',
    agentProtocol: {
      selector: '[data-tutorial-id="virtual-grid-select-all"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Updates selectedTrackIds Set with all filtered track IDs.',
    },
    contextTransition: (a) => a.setViewMode('virtual_table'),
  },
  {
    id: 'btn-batch-ai-grid',
    category: 'VIRTUAL_GRID_VIEW',
    categoryLabel: 'View Mode: Virtual Data Grid',
    targetSelector: '[data-tutorial-id="btn-batch-ai-grid"]',
    title: 'Batch Diff (Up to 25 Tracks) Button',
    role: 'Opens the Batch Diff Metadata Resolution dialog for up to 25 tracks checked in the Virtual Grid.',
    humanExplanation:
      'Appears whenever tracks are selected in the Virtual Grid. Triggers federated Batch Diff comparison across Apple iTunes, MusicBrainz, and Gemini AI. Allows selecting candidates per track or in bulk, editing fields manually, and staging changes non-destructively in JSON sidecars.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-batch-ai-grid"]',
      interactionType: 'click',
      apiEndpoints: ['/api/itunes-search', '/api/musicbrainz-search', '/api/gemini-ai'],
      dataModelMutation: 'Opens BatchDiffTracksModal with selected tracks.',
    },
    contextTransition: (a) => {
      a.setViewMode('virtual_table')
      a.selectTracks(['trk-1', 'trk-2'])
    },
  },
  {
    id: 'btn-spreadsheet-multi-edit',
    category: 'VIRTUAL_GRID_VIEW',
    categoryLabel: 'View Mode: Virtual Data Grid',
    targetSelector: '[data-tutorial-id="btn-spreadsheet-multi-edit"]',
    title: 'Spreadsheet Multi-Edit Mode (Alt+E)',
    role: 'Enables in-place editable cells across all columns for rapid spreadsheet editing.',
    humanExplanation:
      'Toggles spreadsheet mode. Allows you to click directly into table cells (Title, Artist, Album, Year, Track Number) and type edits directly. Pressing Enter commits the edit to non-destructive sidecars and navigates down to the next row.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-spreadsheet-multi-edit"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Enables isMultiEditOpen state, turning grid cells into editable input fields.',
      keyboardShortcut: 'Alt+E',
    },
    contextTransition: (a) => a.setViewMode('virtual_table'),
  },
  {
    id: 'grid-sidecar-status-pill',
    category: 'VIRTUAL_GRID_VIEW',
    categoryLabel: 'View Mode: Virtual Data Grid',
    targetSelector: '[data-tutorial-id="grid-sidecar-status-pill"]',
    title: 'Track Sidecar Status Pill',
    role: 'Displays transactional state: "synced" (green), "uncommitted_sidecar" (amber), or "committed" (cyan).',
    humanExplanation:
      'Each row displays its current transactional sidecar state: "synced" means file tags match sidecars; "uncommitted_sidecar" means non-destructive edits are staged and awaiting 2-phase commit; "committed" means sidecars have been permanently written to disk.',
    agentProtocol: {
      selector: '[data-tutorial-id="grid-sidecar-status-pill"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Reflects Track.sidecarStatus ("synced" | "uncommitted_sidecar" | "committed").',
    },
    contextTransition: (a) => a.setViewMode('virtual_table'),
  },

  // ==========================================
  // 7. RIGHT PANEL: INSPECTOR, CREDITS & DIFF
  // ==========================================
  {
    id: 'right-panel-tab-credits',
    category: 'RIGHT_PANEL_CREDITS',
    categoryLabel: 'Right Panel: Inspector',
    targetSelector: '[data-tutorial-id="right-panel-tab-credits"]',
    title: 'Credits & Technical Inspector Tab',
    role: 'Switches the Right Panel to Granular Credits, Waveform Stats, and Technical Specs.',
    humanExplanation:
      'Activates the Credits Tab. Displays accurate technical parameters (container format, sample rate, bit depth, bitrate, channel count, duration), waveform peak/RMS stats, dynamic range meter, and the Granular Credits Matrix.',
    agentProtocol: {
      selector: '[data-tutorial-id="right-panel-tab-credits"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets RightPanel activeTab to "credits".',
    },
    contextTransition: (a) => a.setRightPanelTab('credits'),
  },
  {
    id: 'credits-matrix-container',
    category: 'RIGHT_PANEL_CREDITS',
    categoryLabel: 'Right Panel: Inspector',
    targetSelector: '[data-tutorial-id="credits-matrix-container"]',
    title: 'Granular Credits Matrix',
    role: 'Multi-role authority ledger tracking Composers, Arrangers, Conductors, Ensembles, and Soloists.',
    humanExplanation:
      'Audiophile classical and jazz metadata requires granular credit tracking far beyond simple "Artist". The matrix maps distinct roles: Composer, Conductor, Primary Artist, Soloist, Ensemble, Recording Engineer, and Mastering Engineer. Click "Add Credit" to add verified personnel.',
    agentProtocol: {
      selector: '[data-tutorial-id="credits-matrix-container"]',
      interactionType: 'inspect',
      apiEndpoints: [],
      dataModelMutation: 'Renders Track.credits array with Credit objects.',
    },
    contextTransition: (a) => a.setRightPanelTab('credits'),
  },
  {
    id: 'right-panel-tab-diff',
    category: 'RIGHT_PANEL_DIFF',
    categoryLabel: 'Right Panel: Federated Diff',
    targetSelector: '[data-tutorial-id="right-panel-tab-diff"]',
    title: 'Federated Diff Resolver Tab',
    role: 'Switches Right Panel to the multi-authority federated comparison and selective merge engine.',
    humanExplanation:
      'Activates the Federated Diff Resolver. Cadence queries multiple external catalog authorities simultaneously (iTunes / Apple Music, MusicBrainz, Discogs, and Gemini AI) and presents a side-by-side comparison against your local audio file tags.',
    agentProtocol: {
      selector: '[data-tutorial-id="right-panel-tab-diff"]',
      interactionType: 'click',
      apiEndpoints: ['/api/itunes-search', '/api/musicbrainz-search', '/api/gemini-ai'],
      dataModelMutation: 'Sets RightPanel activeTab to "diff".',
    },
    contextTransition: (a) => a.setRightPanelTab('diff'),
  },
  {
    id: 'diff-provider-selector',
    category: 'RIGHT_PANEL_DIFF',
    categoryLabel: 'Right Panel: Federated Diff',
    targetSelector: '[data-tutorial-id="diff-provider-selector"]',
    title: 'Authority Provider Selector Pills',
    role: 'Toggles comparison columns across Local, iTunes, MusicBrainz, Discogs, and Gemini AI.',
    humanExplanation:
      'Enables you to toggle specific authority sources on and off. Each source brings unique strengths: iTunes provides clean typography and 3000x3000px master artwork; MusicBrainz provides open-source relationship GUIDs and classical works; Discogs provides vinyl runouts; Gemini AI resolves obscure or damaged tags.',
    agentProtocol: {
      selector: '[data-tutorial-id="diff-provider-selector"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Filters displayed candidate columns in SideBySideDiff.',
    },
    contextTransition: (a) => a.setRightPanelTab('diff'),
  },
  {
    id: 'btn-query-gemini-ai',
    category: 'RIGHT_PANEL_DIFF',
    categoryLabel: 'Right Panel: Federated Diff',
    targetSelector: '[data-tutorial-id="btn-query-gemini-ai"]',
    title: 'Query Gemini AI (On-Demand) Button',
    role: 'Invokes Gemini AI to analyze file paths, raw tags, and acoustic context for canonical metadata.',
    humanExplanation:
      'Triggers an on-demand Gemini AI analysis for the currently selected track. Especially powerful when audio files have garbled filenames or missing tags. Gemini identifies the exact canonical recording, album, year, composer, and catalog details.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-query-gemini-ai"]',
      interactionType: 'click',
      apiEndpoints: ['/api/gemini-ai'],
      dataModelMutation: 'Fetches AI candidate, updates candidates array in SideBySideDiff.',
    },
    contextTransition: (a) => a.setRightPanelTab('diff'),
  },
  {
    id: 'diff-table-cells',
    category: 'RIGHT_PANEL_DIFF',
    categoryLabel: 'Right Panel: Federated Diff',
    targetSelector: '[data-tutorial-id="diff-table-cells"]',
    title: 'Interactive Field Cell Selection Pills',
    role: 'Clickable pills allowing granular field-by-field selective merging from any authority.',
    humanExplanation:
      'Instead of forcing an all-or-nothing overwrite, Cadence gives you surgical control: you can select the Track Title from MusicBrainz, Release Year from iTunes, Catalog Number from Discogs, and Composer from Gemini AI with single clicks.',
    agentProtocol: {
      selector: '[data-tutorial-id="diff-table-cells"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Updates selectedOptions map for that field in SideBySideDiff.',
    },
    contextTransition: (a) => a.setRightPanelTab('diff'),
  },
  {
    id: 'btn-stage-selective-merge',
    category: 'RIGHT_PANEL_DIFF',
    categoryLabel: 'Right Panel: Federated Diff',
    targetSelector: '[data-tutorial-id="btn-stage-selective-merge"]',
    title: 'Stage Selective Merge in Sidecar Button',
    role: 'Stages all chosen field selections into the non-destructive track sidecar and persists to IndexedDB.',
    humanExplanation:
      'Applies the chosen field selections to the track\'s pending sidecar edits. It updates the UI immediately, persists the staged edits to IndexedDB, updates the "Sidecars Staged" counter, and prepares the track for bit-perfect 2-phase commitment.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-stage-selective-merge"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Calls graphEngine.updateTrackSidecar and persistCurrentLibrary().',
    },
    contextTransition: (a) => a.setRightPanelTab('diff'),
  },
  {
    id: 'right-panel-tab-media',
    category: 'RIGHT_PANEL_ARTWORK',
    categoryLabel: 'Right Panel: Artwork Media',
    targetSelector: '[data-tutorial-id="right-panel-tab-media"]',
    title: 'Artwork & Booklet Media Tray Tab',
    role: 'Inspects high-resolution cover scans, color profiles, back covers, and liner note booklets.',
    humanExplanation:
      'Activates the Media Tab. Displays front cover scans up to 3000x3000px, color profile tags, inner sleeve art, and digital booklet PDFs. Also provides warnings if artwork resolution is below audiophile standards (< 800px).',
    agentProtocol: {
      selector: '[data-tutorial-id="right-panel-tab-media"]',
      interactionType: 'click',
      apiEndpoints: ['/api/track-art'],
      dataModelMutation: 'Sets RightPanel activeTab to "artwork".',
    },
    contextTransition: (a) => a.setRightPanelTab('artwork'),
  },
  {
    id: 'right-panel-tab-integrity',
    category: 'RIGHT_PANEL_INTEGRITY',
    categoryLabel: 'Right Panel: Integrity',
    targetSelector: '[data-tutorial-id="right-panel-tab-integrity"]',
    title: 'Bitstream Integrity & Checksum Verifier Tab',
    role: 'Inspects audio stream MD5 hashes, FLAC CRC block validity, and AccurateRip confidence.',
    humanExplanation:
      'Activates the Integrity Tab. Audio purity is paramount: this card verifies that the raw PCM/DSD audio bitstream is 100% bit-perfect and free of bit-rot. It checks the FLAC CRC against the Vorbis comment block and computes stream MD5 checksums.',
    agentProtocol: {
      selector: '[data-tutorial-id="right-panel-tab-integrity"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Sets RightPanel activeTab to "integrity".',
    },
    contextTransition: (a) => a.setRightPanelTab('integrity'),
  },
  {
    id: 'btn-reverify-checksum',
    category: 'RIGHT_PANEL_INTEGRITY',
    categoryLabel: 'Right Panel: Integrity',
    targetSelector: '[data-tutorial-id="btn-reverify-checksum"]',
    title: 'Re-compute / Verify Stream Checksum Button',
    role: 'Re-calculates the audio stream MD5 checksum and verifies CRC consistency.',
    humanExplanation:
      'Triggers a live re-verification of the file\'s audio stream CRC and MD5 hash. Confirms that tag edits have not compromised or shifted the underlying audio stream bytes by even a single bit.',
    agentProtocol: {
      selector: '[data-tutorial-id="btn-reverify-checksum"]',
      interactionType: 'click',
      apiEndpoints: [],
      dataModelMutation: 'Calls onReverifyChecksum(trackId), updating Track.checksumValid.',
    },
    contextTransition: (a) => a.setRightPanelTab('integrity'),
  },

  // ==========================================
  // 8. MODALS & TRANSACTION PIPELINES
  // ==========================================
  {
    id: 'modal-staged-commit-pipeline',
    category: 'MODALS',
    categoryLabel: 'Modals: Staged for Commit',
    targetSelector: '[data-tutorial-id="modal-staged-commit-pipeline"]',
    title: '2-Phase Commit Safe Parity Pipeline',
    role: '5-phase atomic transactional commit engine writing .sidecar.json files to disk with atomic rollback.',
    humanExplanation:
      'The heart of Cadence\'s safety architecture. Before modifying anything, Phase 1 validates storage mount write locks, checks bitstream checksums, and creates a pre-commit snapshot. Phase 2 calls /api/commit-tags to write .sidecar.json and cadence-album.sidecar.json files directly to the directory on disk (including TrueNAS network shares). Rollback button allows 1-click snapshot restoration.',
    agentProtocol: {
      selector: '[data-tutorial-id="modal-staged-commit-pipeline"]',
      interactionType: 'click',
      apiEndpoints: ['/api/commit-tags'],
      dataModelMutation: 'Executes transactionEngine.executeTwoPhaseCommit, updates graphEngine and IndexedDB.',
    },
    contextTransition: (a) => a.openCommitModal(),
  },
]
