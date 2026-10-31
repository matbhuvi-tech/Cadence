# Window Sizing, Responsive Breakpoints & Ultrawide (3440×1440) Workbench Architecture

*   **Author:** Antigravity (Elephant-Goldfish Model Design)
*   **Status:** Approved
*   **Date:** 2026-10-31

--------------------------------------------------------------------------------

## Overview

Cadence is a bit-perfect, desktop-first audiophile application built with Tauri v2 and React 19/Tailwind CSS v4. On high-resolution and ultrawide monitors (such as 3440×1440 21:9 displays) and smaller laptop screens (1120px–1280px), the application currently lacks explicit layout boundaries and geometry persistence.

This feature establishes a hardened window lifecycle, a decoupled and collision-proof secondary navigation bar, and an ultrawide workbench architecture that optimizes screen real estate on large displays while preserving usability on compact laptop screens.

## The Problem

1. **Header & Secondary Navigation Collisions**: On initial startup or viewports near 1200px, scope navigation buttons (`Albums`, `Artists`, `Composers`, `Tracks`) collide directly with view mutation controls (`Year`, `Sort`, `Filter`, `Density toggles`), causing text overlaps, clipped buttons, and unpredictable multi-line flex-wrapping.
2. **Window Lifecycle & Geometry Amnesia**: Cadence does not persist its window dimensions, position, or maximized state between sessions. On 3440×1440 displays, default startup geometry can feel awkward, and if the app was maximized on an external ultrawide monitor that is later disconnected, restoring coordinates can place the window offscreen in unreachable virtual desktop space.
3. **Ultrawide Optical Disconnect**: At 3440px wide, grid layouts stretch into 16+ album covers per row, and virtual data tables stretch track titles to the far left while pushing technical audiophile metrics (Format, Sample Rate, DR score, Bit-rot Checksums) to pixel 3430, causing visual disconnection and neck strain.

## Goals

*   **Enforce Strict Minimum Window Boundaries**: Lock minimum window inner size to `1120×720px` in Tauri configuration to guarantee that Windows 11 title bar and DWM non-client borders do not compress the usable React canvas below 1120px on 13" laptop screens (upgraded from legacy 1100×720).
*   **Implement Safe Window State Persistence**: Save and restore window dimensions, coordinates, and maximized state across sessions via `tauri-plugin-window-state`, including offscreen recovery clamping when monitors are disconnected.
*   **Prevent Header & Filter Bar Collisions**: Decouple Scope Navigation from View Controls and enforce a 3-tier container-calibrated collapse strategy (`containerWidth >= 960px` inline, `820px <= containerWidth < 960px` icon-only, `containerWidth < 820px` consolidated popover) with `flex-nowrap` guarantees.
*   **Retire Redundant Sub-Toolbars**: Eliminate duplicate sub-toolbar headers in `AlbumCoverGrid.tsx`, establishing `DataCanvas.tsx` as the single source of truth for scope navigation, sorting, and view density.
*   **Constrain Ultrawide Content Widths**: Bound album/artist grid containers to `max-w-[2560px]` (8–10 covers per row) and table tracklists to `max-w-[2000px]`, pinning technical audio columns adjacent to metadata with cohesive scrollbar rails.
*   **Introduce Modular 3-Pane Ultrawide Detail Workbench**: On displays `>= 2560px`, partition album/item detail views into a 3-pane workbench (Left: Artwork/Badges; Center: Tracklist Table; Right: Copilot/Audio Inspector/Sidecar Diff), coordinating with the root layout to prevent duplicate right drawers.

## Non-Goals

*   **Audio Engine Modifications**: Zero changes to the WASAPI Exclusive backend, MMCSS Pro Audio pacing loops, or `VirtualLock` memory pinned buffers.
*   **Mobile / Small Tablet Breakpoints**: Cadence does not support viewports below `1120px` wide; mobile control is handled independently via the Remote PWA.
*   **Transport Footer Redesign**: The bottom audio player bar already maintains responsive flex boundaries and is excluded from this scope.

## Open Questions

*   **Multi-Window Future Proofing**: Does `tauri-plugin-window-state` need to track multiple windows (e.g. detached secondary inspector window), or strictly the primary application window? *(Resolved: Primary main window only for this iteration).*

## Critical User Journeys (CUJs)

### CUJ 1: First Launch & Window Sizing on Ultrawide Display
*   **Given**: A user running Cadence on a 3440×1440 Samsung Odyssey monitor for the first time.
*   **When**: The application launches.
*   **Then**: The window opens centered on the primary monitor at `1440×900px`, avoiding full-screen auto-maximization, with all controls aligned and uncluttered.

### CUJ 2: Window Geometry Persistence & Monitor Disconnect Recovery
*   **Given**: The user resizes the window to `2400×1200px` on their external 3440×1440 monitor and closes Cadence, then unplugs the external monitor and uses their 1920×1080 laptop display.
*   **When**: Cadence is relaunched on the laptop display.
*   **Then**: The window-state restore logic detects that the saved coordinates exceed the current display bounds, safely clamping and centering the window within the active display area without being lost offscreen.

### CUJ 3: Compact Window Resizing & Secondary Header Collapse
*   **Given**: A user resizes their window down toward the minimum width (`1120px`).
*   **When**: The content width drops below `1200px` and then below `1180px`.
*   **Then**: Scope tabs remain fixed on the left; at `1180px–1199px` view controls collapse to icons, and below `1180px` they consolidate into a single `[ Filters & Sort (N) ]` popover button. Zero text overlapping or multi-line wrapping occurs.

### CUJ 4: Ultrawide 3-Pane Detail Workbench Navigation
*   **Given**: Cadence is running maximized on a 3440×1440 display.
*   **When**: The user clicks into an album detail view.
*   **Then**: The interface displays a 3-pane workbench: Left pane shows large 1:1 artwork and physical/audio badges; Center pane shows the tracklist table; Right pane shows the Copilot and Audio Inspector, eliminating horizontal stretching.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. Window Lifecycle & Bounds Recovery Architecture (Rust / Tauri v2)

```text
+---------------------------------------------------------------------------------------------------+
| Tauri v2 Native Core                                                                             |
|                                                                                                   |
|   tauri.conf.json                                                                                 |
|     +-- width: 1440, height: 900, minWidth: 1120, minHeight: 720, center: true                   |
|                                                                                                   |
|   src-tauri/src/lib.rs                                                                            |
|     +-- Builder::default()                                                                        |
|     +-- .plugin(tauri_plugin_window_state::Builder::default()                                     |
|     |     .with_state_flags(tauri_plugin_window_state::StateFlags::all()                          |
|     |         ^ tauri_plugin_window_state::StateFlags::VISIBLE)                                   |
|     |     .build())                                                                               |
|     +-- .setup(|app| {                                                                            |
|           // Window Bounds Recovery Hook:                                                         |
|           // Listen for window creation / physical realization event.                             |
|           // Query window.outer_position() against window.available_monitors().                   |
|           // If restored coordinates are outside all active monitor bounding boxes,              |
|           // safely call window.center() and resize to 1440x900px.                                |
|         })                                                                                        |
+---------------------------------------------------------------------------------------------------+
```

*   **Plugin Integration**: In `src-tauri/Cargo.toml`, add `tauri-plugin-window-state = "2"`.
*   **Isolation Guarantee**: Window state storage operates via OS-managed app data paths (`%APPDATA%/com.cadence.core`). Zero reads or writes are issued to audio library directories, maintaining absolute compliance with Audiophile Transport Rule 1 (Storage Bus Silence).
*   **Multi-Monitor Guard**: When waking or launching, verify that the outer position `(x, y)` intersects at least one monitor returned by `window.available_monitors()`. If off-screen, call `window.center()` and reset to `(1440, 900)`.

### 2. Decoupled Responsive Filter & Scope Bar Architecture (React / Tailwind)

Currently, `DataCanvas.tsx` mixes the entity scope switcher (`Albums`, `Artists`, `Composers`, `Tracks`), inline search input (`⌘F`), active token chips, the filter shelf button, sort select, and grid size buttons inside a single wrapping container. When viewport width shrinks below 1280px, items collide and wrap inconsistently.

```text
+----------------------------------------------------------------------------------------------------------+
| Secondary Sub-Toolbar Header Container (flex items-center justify-between flex-nowrap min-w-0 z-20)     |
|                                                                                                          |
| [LEFT: Scope Navigation Group]             [RIGHT: View Mutations & Controls Group]                      |
| (flex items-center gap-2 shrink-0)         (flex items-center gap-2 shrink-0)                            |
|                                                                                                          |
| +--------------------------------------+   +-----------------------------------------------------------+ |
| | [Albums (N)] [Artists] [Comps] [Trk] |   | Tier 1 (>=960px container): [Filter (⌘F)] [Sort: ▼] [C|S|L] | |
| +--------------------------------------+   | Tier 2 (820-959px container): [<Filter>] [<Sort>] [<Grid>]| |
|                                            | Tier 3 (<820px container):   [[ Filters & Sort (N) ]]     | |
|                                            +-----------------------------------------------------------+ |
+----------------------------------------------------------------------------------------------------------+
```

*   **Decoupled Components**:
    - **`CatalogScopeBar`**: Houses the entity switcher tabs with explicit text truncate guards and stable min-widths.
    - **`ViewControlCluster`**: Encapsulates Sort, Density, and Filter triggers with responsive tiering.
*   **Container-Calibrated Responsive Tier Implementation**:
    - Using a lightweight resize observer hook (`useContainerBreakpoint`) measuring the `DataCanvas` container width directly (accounting for the 260px LeftRail and collapsible Copilot drawer):
      - **Tier 1 (Wide - `containerWidth >= 960px`)**: Full text labels, inline `<select>` for sort, inline 3-button density toggle (corresponds to window >= ~1220px with 260px rail).
      - **Tier 2 (Compact - `820px <= containerWidth < 960px`)**: Icon buttons with tooltips for Sort, Filter, and Density (corresponds to window ~1080px–1220px with rail).
      - **Tier 3 (Popover - `containerWidth < 820px`)**: Consolidated Apple HIG popover trigger `[ Filters & Sort (N) ]` opening an overlay card containing Sort select, density switcher, and filter tokens.
    - **`flex-nowrap` Guarantee**: Both left and right containers specify `shrink-0` with `nowrap`, preventing controls from ever dropping to a second row.
*   **Retire Redundant Sub-Toolbars**: Remove the legacy duplicate sub-toolbar implementation from `AlbumCoverGrid.tsx` (Lines 1601–1824). `DataCanvas.tsx` is the sole owner of sub-toolbar layout, state, and rendering.

### 3. Ultrawide (3440×1440) Workbench & Optical Real Estate Strategy

On a 3440×1440 display, Cadence leverages horizontal space without inducing eye/neck strain:

```text
=============================================================================================================
3440px Ultrawide Viewport
=============================================================================================================
[LeftRail: 260px] | [Center Stage Canvas: max-w-[2560px] / Detail Workbench: 3-Panes]
                  |
                  | A. Browse Grids (Albums/Artists):
                  |    - max-w-[2560px] mx-auto w-full px-8
                  |    - repeat(auto-fill, minmax(210px, 1fr)) -> Caps at ~8-10 cards per row.
                  |
                  | B. Virtual Track Table:
                  |    - max-w-[2000px] mx-auto w-full
                  |    - Audio columns (Format, SR, DR, Checksum) clumped within reading distance of Title.
                  |
                  | C. Detail View (>= 2560px Viewport - 3-Pane Workbench):
                  |    +--------------------+-----------------------------+--------------------------------+
                  |    | PANE 1: HERO / ART | PANE 2: TRACKLIST STAGE     | PANE 3: AUDIOPHILE INSPECTOR   |
                  |    | Width: 380px–420px | Width: Flexible (1400px+)   | Width: 460px–520px             |
                  |    | - 1:1 Large Cover  | - Disc groupings & titles   | - Dynamic Range Histogram      |
                  |    | - Masterpiece/DR   | - Virtualized track table   | - Bit-rot Integrity Checksum   |
                  |    | - Edition / Folder | - Inline waveform/movement  | - Sidecar Diff & Copilot AI    |
                  |    | - Primary Actions  | - Gapless/Sample-rate badge | - Audio Stream Diagnostics     |
                  |    +--------------------+-----------------------------+--------------------------------+
```

*   **Grid Constraint**: Standardize album grid layouts on `max-w-[2560px] mx-auto w-full` to eliminate rows of 15+ cards.
*   **Virtual Table Constraint**: Apply `max-w-[2000px] mx-auto` to row wrappers inside `VirtualDataTable`, keeping technical columns in close optical proximity to track titles while allowing the virtual scroll container to reach the viewport edge.
*   **Detail View Workbench**: In `AlbumCoverGrid.tsx` and detail views, when container width >= 2560px, replace the stacked vertical layout with a horizontal 3-column CSS grid (`grid-cols-[400px_1fr_480px] gap-8`).

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Uncontrolled Multi-Line Flex-Wrapping in the Sub-Toolbar
*   **Pros**: Trivial to implement using default CSS `flex-wrap` without needing JavaScript resize observers or container-query logic.
*   **Cons**: Pushes secondary filters and controls onto a second row, pushing the primary album grid and tracklist down and creating an inconsistent, vertically shifting layout as users resize their windows. Furthermore, on dense desktop displays it consumes valuable vertical real estate.
*   **Reason for Rejection**: Violates the Apple Human Interface Guidelines for desktop utility tools. A fixed-height, single-row sub-toolbar with progressive collapse (labels -> icons -> popover) guarantees predictable alignment, zero vertical jitter, and immediate scannability.

### Alternative B: Global Viewport Media Queries (`@media`) Instead of Container Queries / Observers
*   **Pros**: Built into standard CSS without requiring component-level measurement or React state hooks.
*   **Cons**: Viewport media queries measure the full window width rather than the actual available canvas space. In Cadence, the left navigation rail can be expanded, collapsed, or hidden, and the right drawer (Curation / Copilot) can be toggled. If media queries were used, the sub-toolbar would collide whenever a side panel opened even if the overall window width exceeded 1200px.
*   **Reason for Rejection**: The responsive tier must respond to the *available width of the canvas container*, not the total screen or window width. Using container measurements prevents edge-case collisions when sidebars are opened.

### Alternative C: Unconstrained Full-Bleed Scaling on Ultrawide Monitors
*   **Pros**: Fills 100% of the 3440px or 5120px screen width without any empty flanking margins.
*   **Cons**: Displays 16–20 album covers per row, making individual album art tiny and difficult to scan. On tracklist tables, it places the track title at pixel 280 on the far left and the audio resolution/DR score at pixel 3400 on the far right, forcing constant lateral head turning to read a single row of audio metadata.
*   **Reason for Rejection**: High-resolution audiophile workflows require high visual density without ergonomics penalties. Bounding grids to `2560px` (~8–10 covers) and tables to `2000px`, while dedicating extra ultrawide space to a persistent 3-pane workbench (Art/Specs + Tracklist + Inspector), provides genuine productivity rather than stretched whitespace.

### Alternative D: Unconstrained Tauri Window Auto-Maximizing on First Launch
*   **Pros**: Automatically uses all available screen real estate without user interaction.
*   **Cons**: On 3440×1440 or 4K/5K displays, auto-maximizing on first launch creates an overwhelming visual canvas for first-time onboarding and can cause window placement glitches across complex multi-monitor setups.
*   **Reason for Rejection**: Starting with a centered `1440×900px` window provides an immediate, balanced presentation on any monitor. Users who want full-screen ultrawide immersion can maximize the window, and that choice is then safely persisted across future sessions via `tauri-plugin-window-state`.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `src-tauri/Cargo.toml` (Modify)
*   **Type / Scope**: Rust Package Manifest
*   **Proposed Changes**:
    *   Add `tauri-plugin-window-state = "2"` under `[dependencies]`.
*   **Rationale**: Required to enable persistent window geometry, position, and maximized state tracking natively through Tauri's official plugin.

#### 2. `src-tauri/tauri.conf.json` (Modify)
*   **Type / Scope**: Tauri App Window Configuration
*   **Proposed Changes**:
    *   Update main window settings:
        *   `"width": 1440`
        *   `"height": 900`
        *   `"minWidth": 1120`
        *   `"minHeight": 720`
        *   `"center": true`
*   **Rationale**: Enforces strict minimum bounding dimensions to prevent UI element overlapping on smaller screens and sets a well-proportioned initial launch geometry.

#### 3. `src-tauri/src/lib.rs` (Modify)
*   **Type / Scope**: Native Rust Application Entry Point
*   **Proposed Changes**:
    *   Register `tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::all() ^ tauri_plugin_window_state::StateFlags::VISIBLE).build()`.
    *   In the window setup / event lifecycle, attach an offscreen recovery hook: query `window.outer_position()` against all bounds in `window.available_monitors()`. If none of the active display rectangles contain the window's top-left coordinates (e.g., disconnected ultrawide display), clamp and center the window via `window.center()` and `window.set_size(LogicalSize::new(1440.0, 900.0))`.
*   **Rationale**: Restores window state reliably on launch while preventing the window from opening in an unreachable virtual desktop coordinate space.

#### 4. `src/hooks/useContainerBreakpoint.ts` (Create)
*   **Type / Scope**: React Custom Hook
*   **Proposed Changes**:
    *   Implement a `ResizeObserver`-backed hook measuring container element width:
        *   `tier: 'wide' (containerWidth >= 960px) | 'compact' (820px <= containerWidth < 960px) | 'popover' (containerWidth < 820px)`.
        *   `isUltrawide: boolean (containerWidth >= 2200px || windowWidth >= 2560px)`.
*   **Rationale**: Decouples responsive styling from global viewport media queries, ensuring the sub-toolbar and detail panes adapt correctly based on their actual container width (accounting for LeftRail and Copilot drawers).

#### 5. `src/components/CenterStage/SubToolbar/CatalogScopeBar.tsx` (Create)
*   **Type / Scope**: React Component (Left Scope Navigation)
*   **Proposed Changes**:
    *   Extract the entity tab group (`Albums`, `Artists`, `Composers`, `Tracks`) from `DataCanvas.tsx`.
    *   Enforce `shrink-0`, `flex-nowrap`, and text-truncation limits with fixed minimum badge widths to guarantee zero wrapping.
*   **Rationale**: Provides clean separation of concerns and guarantees that scope navigation remains pinned and uncompressed on the left.

#### 6. `src/components/CenterStage/SubToolbar/ViewControlCluster.tsx` (Create)
*   **Type / Scope**: React Component (Right View Controls & Mutations)
*   **Proposed Changes**:
    *   Extract Filter Shelf toggle (`Filter (⌘F)`), Sort By dropdown, and Card Size buttons (`Compact`, `Standard`, `Large`).
    *   Implement 3-tier progressive disclosure:
        *   `wide` (`>= 960px`): Full labels, visible inline `<select>` and button group.
        *   `compact` (`820px–959px`): Icon-only buttons with tooltips (`<Filter />`, `<ArrowUpDown />`, `<LayoutGrid />`).
        *   `popover` (`< 820px`): Single `[ Filters & Sort (N) ]` trigger opening an Apple HIG popover containing the controls.
*   **Rationale**: Prevents horizontal header collisions by collapsing mutations into an icon or popover pattern before any collision can occur.

#### 7. `src/components/CenterStage/DataCanvas.tsx` (Modify)
*   **Type / Scope**: Center Stage Container Component
*   **Proposed Changes**:
    *   Replace inline mixed sub-toolbar with `<CatalogScopeBar />` and `<ViewControlCluster />`.
    *   Apply `flex-nowrap`, `justify-between`, and `min-w-0` to the sub-toolbar header container.
    *   Attach `useContainerBreakpoint` ref to the main content container.
    *   Apply `max-w-[2560px] mx-auto w-full` to the album cover grid viewport wrapper.
    *   Apply `max-w-[2000px] mx-auto w-full` to inner row containers in table views.
*   **Rationale**: Eliminates sub-toolbar collision bugs and binds ultrawide max-width constraints to browse and table views.

#### 8. `src/components/CenterStage/AlbumCoverGrid.tsx` (Modify)
*   **Type / Scope**: Center Stage Grid & Album Detail View
*   **Proposed Changes**:
    *   **Retire Redundant Sub-Toolbar**: Completely delete the redundant sub-toolbar block (`Lines 1601–1824`) inside `AlbumCoverGrid.tsx`. `DataCanvas.tsx` is the sole sub-toolbar owner.
    *   In the grid container, enforce `max-w-[2560px] mx-auto w-full px-6 md:px-8` with `repeat(auto-fill, minmax(210px, 1fr))` to cap items at 8–10 covers per row.
    *   In the album detail view (`selectedAlbum` render), modularize the 3-pane workbench when container width `>= 2200px` (viewport `>= 2560px`):
        *   Extract modular panes (`AlbumSpecsPane.tsx`, `AlbumTracklistPane.tsx`, `AlbumInspectorPane.tsx`).
        *   Divide the view into a 3-pane CSS grid (`grid-cols-[400px_1fr_480px] gap-8`).
        *   Left Pane: Cover art, masterpiece badges, folder path, playback buttons.
        *   Center Pane: Disc entries and tracklist table.
        *   Right Pane: Dynamic Range metrics, AI soundtrack identifier, and technical audio inspection.
        *   Coordinate with `App.tsx` to automatically suppress the floating `CurationCopilotDrawer` on ultrawide displays when `AlbumInspectorPane` is mounted, preventing duplicate sidebars.
*   **Rationale**: Resolves ultrawide visual fatigue, removes duplicated code, and transforms 3440px displays into a dedicated 3-pane workbench.

#### 9. `src/hooks/__tests__/useContainerBreakpoint.test.ts` (Create)
*   **Type / Scope**: Unit Test
*   **Proposed Changes**:
    *   Test container width transitions across `wide` (>=960px), `compact` (820-959px), and `popover` (<820px) using mocked `ResizeObserver`.
*   **Rationale**: Ensures automated regression prevention for breakpoint tier transitions.

### Verification Plan

*   **Compilation & Build**:
    *   Validate Rust compilation: `cargo check --manifest-path src-tauri/Cargo.toml`
    *   Validate TypeScript compilation: `npm run build`
    *   Run automated frontend tests: `npm test` (including `useContainerBreakpoint.test.ts`).
*   **Window Bounds & Persistence Verification**:
    *   Launch Cadence: verify initial launch is centered at `1440×900px`.
    *   Resize window to `1120×720px`: verify that Tauri prevents resizing below `1120px` width and `720px` height.
    *   Move window, resize, and close: relaunch to verify position and size restoration via `tauri-plugin-window-state`.
*   **Sub-Toolbar Collision Verification**:
    *   Slowly resize window with 260px left rail open:
        *   At container width `>= 960px`: confirm full text labels for Sort, Filter, and Density.
        *   At container width `820px–959px`: confirm controls collapse to icon-only buttons with tooltips.
        *   At container width `< 820px`: confirm controls consolidate into `[ Filters & Sort (N) ]` popover.
        *   Verify zero multiline wrapping or text overlapping at any width.
        *   Verify that `AlbumCoverGrid` does NOT render a second stacked sub-toolbar.
*   **Ultrawide (3440×1440) Verification**:
    *   Maximize window on 3440×1440 monitor:
        *   Verify album cover grid caps at 8–10 cards per row without sprawling into 16+ tiny tiles.
        *   Verify tracklist table rows remain centered within `max-w-[2000px]` with technical audio columns pinned near track titles.
        *   Open an album detail view: verify 3-pane workbench layout (Art/Specs Left, Tracklist Center, Inspector Right), and confirm the global floating right drawer is gracefully suppressed.
*   **Audiophile Rule Verification**:
    *   Confirm zero disk I/O occurs on music library storage drives during window resizing and layout changes.

--------------------------------------------------------------------------------

*Drafted with EGM*

