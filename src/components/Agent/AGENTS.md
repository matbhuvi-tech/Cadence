# Agent Components

## Overview
Provides the embedded interactive AI Copilot and assistant UI components for Cadence. Surfaces natural language catalog diagnostics, triage suggestions, catalog statistics summaries, and deterministic quick actions within a slide-out assistant drawer.

## Interface
- `EmbeddedAgentDrawer`: Main slide-out conversational drawer handling user chat queries, action execution feedback, and triage suggestions.
- `BatchProposalSheet`: Pre-flight dry-run presentation sheet displaying proposed metadata mutations for AI Copilot recommendations before they enter the staging pool.
- `AgentChatMessage`: Contract representing chat messages, attached commands, telemetry snapshots, and suggested follow-ups.
- `CatalogPulseCard`: Component displaying catalog health pulses, score metrics, and actionable diagnostics recommendations.
- `MicroDiffCard`: Visual card showing proposed metadata modifications before applying them to tracks.
- `MarkdownText`: Markdown renderer for formatted agent reasoning steps and suggestions.

## Invariants
- Agent actions dispatched through `dispatcherContext` must respect the two-phase commit architecture where destructive changes require review.
- State updates in the chat session must never directly mutate track arrays without dispatching through registered action handlers.

## Side Effects
- Dispatches commands through `agentActionDispatcher` which may alter active UI views, selection states, or stage metadata changes.
- Accesses window / viewport dimensions and manages internal auto-scroll behavior for the message stream.

## Verification
- Run: `npm run build`
