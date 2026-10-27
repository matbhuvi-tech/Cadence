# Tutorial Steps Package

## Overview
Houses step definitions, navigation protocols, UI selectors, and explanatory microcopy for the Cadence guided onboarding tutorial.

## Interface
- `TUTORIAL_STEPS`: Ordered list of `TutorialStep` configurations covering header metrics, left rail filters, canvas views, right panel inspectors, and commit modals.
- `TutorialStep`: Data contract defining step categories, DOM target selectors, human explanations, and agent interaction protocols.
- `TutorialActions`: Action dispatcher interface for switching view modes, selecting tabs, and opening modals during walkthrough steps.

## Invariants
- `targetSelector` strings in tutorial steps must correspond to stable `data-testid` or CSS class selectors present in application components.
- Step transitions must not trigger irreversible state changes or mutate audio file tags.

## Side Effects
- Invokes step transition callbacks that switch view modes and active sidebar tabs in the UI.

## Verification
- Run: `npm run build`
