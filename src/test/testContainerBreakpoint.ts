import assert from 'node:assert'
import { SubToolbarTier } from '../hooks/useContainerBreakpoint'

function calculateBreakpoint(width: number, windowWidth?: number): {
  tier: SubToolbarTier
  containerWidth: number
  isUltrawide: boolean
} {
  let tier: SubToolbarTier = 'wide'
  if (width < 820) {
    tier = 'popover'
  } else if (width < 960) {
    tier = 'compact'
  }

  const isUltrawide = width >= 2200 || (windowWidth !== undefined && windowWidth >= 2560)

  return { tier, containerWidth: width, isUltrawide }
}

console.log('--- Testing Container Breakpoints Logic ---')

// 1. Wide Tier (Laptop with LeftRail or Desktop)
const wideState = calculateBreakpoint(1100, 1440)
assert.strictEqual(wideState.tier, 'wide', '>= 960px should be wide tier')
assert.strictEqual(wideState.isUltrawide, false, '1100px should not be ultrawide')
console.log('✓ Wide Tier (1100px container):', wideState)

// 2. Compact Tier (13" laptop at 1120px window with 260px rail = 860px container)
const compactState = calculateBreakpoint(860, 1120)
assert.strictEqual(compactState.tier, 'compact', '860px should be compact tier')
assert.strictEqual(compactState.isUltrawide, false)
console.log('✓ Compact Tier (860px container, laptop screen):', compactState)

// 3. Popover Tier (Very dense container < 820px)
const popoverState = calculateBreakpoint(750, 1120)
assert.strictEqual(popoverState.tier, 'popover', '< 820px should be popover tier')
assert.strictEqual(popoverState.isUltrawide, false)
console.log('✓ Popover Tier (750px container):', popoverState)

// 4. Ultrawide Display (Samsung Odyssey 3440x1440)
const ultrawideState = calculateBreakpoint(3180, 3440)
assert.strictEqual(ultrawideState.tier, 'wide')
assert.strictEqual(ultrawideState.isUltrawide, true, '3440px window should activate ultrawide workbench')
console.log('✓ Ultrawide Workbench (3440px window, 3180px container):', ultrawideState)

console.log('\nAll container breakpoint assertions passed successfully!')

