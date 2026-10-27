# Tutorial Components

## Overview
Houses user onboarding and guided walkthrough modals for Cadence. Steps new users through library setup, audiophile playback engine concepts, copilot agent features, and two-phase commit safety protocols.

## Interface
- `GuidedTutorialModal`: Interactive step-by-step onboarding walkthrough overlay highlighting core interface regions and key principles.

## Invariants
- Completing or dismissing the tutorial must persist completion flags to local storage to avoid prompting users on subsequent launches.

## Side Effects
- Mutates tutorial completion flags in `localStorage`.
- Can programmatically trigger navigation or highlight target DOM elements during tutorial steps.

## Verification
- Run: `npm run build`
