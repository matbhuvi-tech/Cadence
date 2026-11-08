# SubToolbar Package (`src/components/CenterStage/SubToolbar`)

## Overview
Houses decoupled secondary toolbar and catalog navigation components for the CenterStage canvas, providing scope tab navigation across entity types (albums, artists, composers, tracks) and responsive progressive-disclosure view controls.

## Interface
- `CatalogScopeBar`: Scope navigation bar rendering entity tabs (albums, artists, composers, tracks) with item counts and active tab indicators.
- `ScopeTab`: Type defining active entity scope (`'albums' | 'artists' | 'composers' | 'tracks'`).
- `ViewControlCluster`: Responsive view control cluster supporting progressive disclosure tiers (`'wide'`, `'compact'`, `'popover'`) for sorting, card size selection, and filter shelf toggling.
- `SortBy`: Type defining catalog sort orders (`'year_desc' | 'year_asc' | 'artist_asc' | 'title_asc'`).
- `CardSize`: Type defining album grid card sizes (`'compact' | 'standard' | 'large'`).

## Invariants
- `CatalogScopeBar` enforces single-line layout (`flex-nowrap`) and minimum badge widths to prevent layout wrapping or visual collision.
- `ViewControlCluster` adapts layout based on container breakpoint tiers (`'wide'` >= 960px, `'compact'` 820-960px, `'popover'` < 820px).
- Popovers inside `ViewControlCluster` dismiss on Escape key press or outside pointer clicks.

## Side Effects
- Registers and unregisters window event listeners (`mousedown`, `keydown`) during popover open lifecycles.
- Invokes parent state callbacks for tab changes, sort mutations, filter toggling, and card size adjustments.

## Verification
- Run: `npm run build`

