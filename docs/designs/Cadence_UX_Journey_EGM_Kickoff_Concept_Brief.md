# Cadence — Unified Listening Journey
## EGM Brainstorm Kickoff Concept Brief

**Document type:** Concept brief / problem-framing input for Elephant–Goldfish Model (EGM) brainstorming  
**Status:** Draft for exploration — **not** approved UX design or implementation architecture  
**Date:** 9 November 2026  
**Product surfaces:** Cadence Desktop (Windows) and Cadence Mobile Remote (PWA / future mobile client)  
**Benchmark references:** Roon, Audirvāna, Volumio  
**Decision requested:** Establish the user-journey problems, invariants, candidate directions and research questions before creating a solution specification.

---

## 1. The opportunity

Cadence has a differentiated ambition: a transparent, audiophile-grade local music player that combines uncompromised audio playback, a well-organized music library and deliberate metadata governance. Desktop and mobile serve different contexts, yet should feel like **one coherent listening product**.

The current mobile experience is organized around three functional destinations—**Playing**, **Catalog** and **Queue**. This is a reasonable foundation, but the supplied screenshots suggest that the experience may not yet preserve listening context as users move between those destinations. Users can see albums, queued tracks and playback controls; it is less evident how an action on one screen changes the system-wide listening state.

**Concept thesis:** Playback should be a persistent session; discovery and queue management should be activities within that session, not disconnected pages. The desktop and mobile interfaces should project the **same authoritative listening state**, while giving each surface appropriately different controls.

This is a **journey-coherence initiative**, not a mandate to visually redesign Cadence or imitate Roon.

## 2. Why this matters

The experience should answer the questions a listener naturally asks, without interpretation or guesswork:

- What am I listening to, and on which output device?
- What will play next, and what will happen if I choose *Play Now*, *Play Next* or *Add to Queue*?
- Can I find and select an album or a specific edition without interrupting the current track?
- Did my action succeed, fail, or remain pending?
- Which release or processed version will Cadence play—original FLAC, DSD, PGGB, etc.?
- Is the audio path genuinely bit-perfect, or is the interface merely showing a high-resolution file label?
- If the album's metadata is incorrect, is the listening journey still intelligible, and can correction happen safely later on desktop?

**Desired product outcome:** A listener can move from album discovery to intentional playback, inspect or modify the queue, and return to discovery **without losing orientation, changing playback accidentally or wondering what Cadence just did**.

## 3. Intended users and contexts

These are provisional segments to validate in user research, not established research personas.

| Segment | Context | Primary job to be done |
|---|---|---|
| Casual listener | Phone in hand, away from desktop | Find music and play it quickly |
| Album-focused collector | Large local library with multiple editions | Identify the correct album/version and listen in sequence |
| Audiophile listener | Dedicated DAC / network renderer / external amplifier | Preserve fidelity and understand the active signal path |
| Library curator | Desktop, preparing or reviewing metadata | Correct identity and attribution transparently without disrupting listening |

Cross-cutting need: **continuity between desktop and mobile**. Starting or altering playback on one surface should have a predictable, visible result on the other.

## 4. Evidence, observations and confidence

### Available input

1. Three supplied mobile screenshots of **Catalog**, **Playback Queue** and **Playing**.
2. Existing Cadence desktop product direction: persistent playback context, library navigation, queue/sidebar and a dedicated Curate workbench.
3. Comparative desk research into Roon, Audirvāna and Volumio user-journey patterns.
4. Existing Cadence architectural and product rules regarding playback hygiene, deliberate metadata selection and non-destructive curation.

### Observable friction hypotheses

| ID | Observation from provided mobile screens | Potential user impact | Evidence status |
|---|---|---|---|
| H1 | No visible mini-player on Catalog or Queue | Loss of playback context while browsing | Directly visible; actual global player behavior needs testing |
| H2 | Queue shows nine tracks and highlights an apparent current track; Playing shows “No Track Loaded” | Possible confusing or inconsistent playback status | **Conditional**: only a defect if screenshots reflect the same session/time |
| H3 | Several album cards lack artwork | Reduced recognition and catalog confidence | Directly visible; root cause unknown |
| H4 | Multiple entries show “Unknown Artist” | Poor recognition of soundtrack/composer/performer identity | Directly visible; metadata provenance unknown |
| H5 | Queue lacks an obvious reorder handle | Queue reordering may be undiscoverable | Visual observation; gesture behavior unverified |
| H6 | Track and album labels are heavily truncated | Similar tracks/editions are hard to distinguish | Directly visible |
| H7 | “CONNECTED”, “READY”, “HI-RES” and Purity status compete for attention | User may not distinguish connection, device, audio format and bit-perfect state | Heuristic inference |
| H8 | Empty Playing state devotes substantial space to engine artwork | Next action is not obvious when tracks are queued or when there is nothing queued | Directly visible; interaction behavior unverified |
| H9 | Device configuration and volume take substantial screen area | Music and transport may lose visual priority | Heuristic inference |

**Important limitation:** There has not yet been a live, task-based evaluation of the current Cadence desktop and mobile applications or moderated testing with actual users. No timings, failure rates or superiority rankings should be represented as measured results.

## 5. Competitive benchmarks — behaviors to study, not templates to copy

| Benchmark | Pattern worth examining | Potential application to Cadence | Caution |
|---|---|---|---|
| **Roon** | Persistent playback context, clear output/zone identification, Versions model, queue state and signal-path explanation | Continuity, version visibility and verified audio-path transparency | Avoid borrowing interaction complexity or multiroom assumptions Cadence does not need |
| **Audirvāna** | Deliberate playback/queue actions and audiophile output configuration | Clear intent before playback, accessible technical controls | Keep configuration out of the primary browsing path |
| **Volumio** | Streamer-centric remote control and consistent cross-device navigation | Fast remote journeys, device confidence, practical queue control | Avoid source/zone complexity irrelevant to Cadence |
| **Cadence desktop** | Existing library + queue + player + separate Curate workflow | Establish one shared information model across desktop and remote | Do not assume current desktop behaviors are implemented exactly as designed |

### Competitive research tasks for EGM

- Walk through the **same representative tasks** in each product, including the exact tap/click sequence, number of context switches and feedback after each action.
- Examine how each product treats **album tap**, **track tap**, **Play Now**, **Play Next**, **Add to Queue**, **queue clearing**, **version selection** and **output switching**.
- Distinguish production functionality from betas, marketing claims or community preferences.
- Capture where competitors themselves introduce friction. Do not assume a popular feature is automatically appropriate for Cadence.

## 6. Problem statement

> **How might Cadence deliver a continuous, understandable album-to-listening journey across desktop and mobile, while preserving deliberate queue behavior, exact edition selection, trusted audio-path feedback and strict playback hygiene?**

Success is **not** simply minimizing clicks or adding a mini-player. Success requires clarity of intention, continuity of context, accurate state and no negative impact on audio playback.

## 7. Critical user journeys to explore

### Journey A — Find an album and start playback

**Scenario:** A listener searches for a Tamil soundtrack from the phone, opens it, selects an available version if necessary, and starts playback through the already selected output.

Investigate:
- Can the user distinguish an album, a release and a processed/versioned file?
- What does tapping the **album card** do? What does tapping a **track** do?
- What is the simplest *deliberate* path from album to listening?
- What happens if a queue already exists?
- How does Cadence confirm the **selected version**, **output** and **playback result**?

### Journey B — Add music without interrupting playback

**Scenario:** While one track plays, the listener browses another album and chooses *Play Next* or *Add to Queue*.

Investigate:
- Is Now Playing context retained on Catalog and Queue?
- Are *Play Next* and *Add to Queue* semantically different, stable and obvious?
- Can the user see the insertion position without leaving the current context?
- Can the user undo an accidental queue operation?

### Journey C — Understand and manipulate the queue

**Scenario:** The listener opens Queue, identifies the active track, moves a track earlier, skips another and removes an upcoming entry.

Investigate:
- How are **Now Playing**, **Up Next** and **Later** represented?
- Should track rows use album artwork (preferred contextual identifier) and album titles in addition to track/artist?
- How are long Tamil/transliterated titles, alternate versions and instrumental/reprise tracks distinguished?
- What does **Clear** clear: the upcoming list, the entire queue, or playback as well?
- What happens to queue order when another controller changes it simultaneously?

### Journey D — Verify output and audio integrity

**Scenario:** The listener is playing a DSD or high-resolution PCM file to a local DAC or network renderer and wants to verify that the intended audio path is active.

Investigate:
- How are **connection status**, **transport readiness**, **actual playback** and **audio-path fidelity** differentiated?
- Should endpoint selection be a compact surface, a drawer or a separate workflow?
- Which technical statements can the engine *verify* (rather than infer from file metadata)?
- How does software volume behave under Purity Mode, WASAPI Exclusive and network playback?

### Journey E — Move between desktop and phone

**Scenario:** Start playback on desktop, pick up phone, reorder tracks, change volume if allowed, and return to desktop.

Investigate:
- Is there exactly **one authoritative playback/queue/device state**?
- How are stale mobile states, reconnects and command errors shown?
- How are pending commands represented without misleading optimistic UI?
- Is browse position preserved when returning from Now Playing or Queue?

### Journey F — Correct metadata without contaminating listening

**Scenario:** The listener notices incorrect soundtrack attribution while listening; later, on desktop, they curate identity and commit the result.

Investigate:
- How should mobile communicate poor/missing metadata without offering curation tools?
- How do revised album/track identities propagate safely to the library and queue?
- Can a curated change accidentally rebind a queued track to a different file or version?
- How are user decisions, provenance and the actual committed result made transparent?

## 8. Non-negotiable product invariants

The brainstorm must explicitly preserve these constraints. EGM should challenge implementation assumptions, **not** silently weaken them.

1. **Audio playback has absolute priority.** When audio is playing, all background Curate work, metadata enrichment, scans, nonessential artwork fetching and other non-playback processing must stop. Avoid unsolicited storage/network activity, heavy allocations or polling that jeopardizes audio hygiene.
2. **Mobile is a controller, not a second audio engine or Curate workbench.** The desktop is authoritative for transport, queue, selected edition and output state.
3. **User actions are explainable.** Every mutation should expose intent, observable outcome, failure or pending state. No opaque or silent queue replacement.
4. **Edition integrity.** Album, release, version and exact track-file identities must remain distinguishable. No implicit swap between FLAC, DSD, PGGB or other processed versions.
5. **Source fidelity is represented truthfully.** File resolution does not by itself prove bit-perfect output. Purity/bit-perfect labels must reflect verifiable engine behavior.
6. **Curation is deliberate and non-destructive.** Metadata staging, provenance, user precedence and explicit commit remain desktop responsibilities. No automatic background correction while listening.
7. **Consistency over visual imitation.** Desktop and mobile may use different layouts, but action semantics and state must match.
8. **Dark premium aesthetic is a strength to preserve.** Retain restrained gold accents, readable hierarchy and album-first identity rather than redesigning purely for novelty.

**Boundary to resolve during brainstorming:** A mobile remote necessarily uses network traffic to deliver user-initiated commands, and a network renderer necessarily requires playback transport traffic. Define which **necessary control-plane operations** are permitted during playback and how they are isolated from forbidden background work. Avoid promising literally zero network, disk or memory operations in a functioning player.

## 9. Candidate solution directions — hypotheses only

These are **design options for comparison**, not accepted requirements:

| Option | Hypothesis | Tradeoff to test |
|---|---|---|
| A. Persistent mini-player on Catalog and Queue | Keeps listening context visible with fewer navigation interruptions | Uses scarce vertical space; empty/paused behavior requires rules |
| B. Album detail as an intentional decision point | Reduces accidental playback and exposes versions and credits | Adds a step for users who expect one-tap playback |
| C. Queue organized into Now Playing / Up Next / Later | Makes queue progression and manipulation understandable | May complicate compact screens or repeat-mode semantics |
| D. Album-art-led queue rows | Improves recognition and album context compared with numerals alone | Artwork availability, loading and density must be addressed |
| E. Compact output summary + expandable signal path | Retains audiophile confidence without cluttering Now Playing | Requires verified telemetry and accurate mode-dependent labels |
| F. Event-driven shared session model | Makes cross-device actions and state consistent | Needs clear reconnection, command ordering and audio-hygiene boundaries |
| G. Contextual command confirmation and undo | Prevents “Did that work?” uncertainty | Feedback must be informative without becoming noisy |

For every option, EGM should explicitly examine **benefit, cognitive cost, implementation cost, audio-hygiene risk, reversibility and failure states**. Multiple credible alternatives are expected.

## 10. Out of scope for this concept phase

- Full visual redesign, finalized Figma screens or component specifications.
- Specific framework selection, API schema, data-model migration or technical implementation plan.
- Introducing cloud streaming subscriptions, recommendations or multiroom playback solely to match competitors.
- Mobile metadata editing, automated tag commits or AI curation running during playback.
- Inferring verified playback behavior from screenshots alone.
- Assuming all competitors' beta features are available in every production edition.

## 11. Research and validation plan

### Before EGM converges on a preferred design

Collect or inspect:

1. **Current desktop journeys** — short screen recordings of browse → album → play, add-next, queue manipulation, device switching and Curate entry/exit.
2. **Current mobile behavior** — tap paths, scrolling, track selection, artwork loading, queue reordering, error states and reconnect.
3. **Playback-state contract** — source of truth for playing track, paused/stopped/empty, queue mutations, selected version and output.
4. **Competitive task walkthroughs** — Roon, Audirvāna and Volumio performing the *same* use cases under comparable conditions.
5. **Small usability study** — 8–12 representative listeners across casual, collector and audiophile contexts; record task completion, errors, navigation detours and comprehension.

### Candidate success measures (targets, not baselines)

- Find and start a known album in **two intentional actions after the album is surfaced**, when no edition decision is needed.
- Reach full Now Playing from any listening screen in **one action**.
- No **silent** queue replacement, change of output, or substitution of file/version.
- A listener can correctly identify the **active output and current playback state** without opening technical settings.
- A listener can distinguish **Play Now**, **Play Next** and **Add to Queue** and predict their outcomes.
- No contradictory desktop/mobile playback states after agreed synchronization/reconnect completion.
- No regression against Cadence's existing audio-hygiene or metadata-governance constraints.

Quantitative thresholds should be refined after baseline measurement; do not claim these goals are already met.

## 12. EGM brainstorm agenda and decision gates

Work **one design problem at a time** to avoid changing fundamentals between iterations.

### Gate 1 — Agree on the problem and journey boundaries

- Which journey produces the most user uncertainty today?
- Is persistent listening context the actual root cause, or are state ownership and inconsistent action semantics more fundamental?
- Which problem is confirmed by behavior versus inferred from appearance?

**Output:** Validated problem statements, prioritized user needs, explicit assumptions.

### Gate 2 — Explore 2–3 viable interaction models

At minimum, compare:
- **Model A:** Persistent mini-player with three stable destinations.
- **Model B:** Playback-centric shell with Catalog and Queue as contextual layers.
- **Model C:** Desktop-informed browsing + contextual overlays, optimized differently for mobile.

**Output:** Journey maps, concise wireframes, behavioral tradeoff matrix. Do not prematurely select one.

### Gate 3 — Resolve action and state semantics

Define precise, testable behavior for album selection, track selection, Play Now, Play Next, Add to Queue, version pinning, Clear, reorder, output selection, failures and reconnects.

**Output:** Cross-device interaction contract and edge-case matrix.

### Gate 4 — Apply audio-hygiene and metadata-governance review

Challenge each candidate for hidden background fetching, unsafe queue/identity mutation, unsupported signal-path claims and mobile/desktop state divergence.

**Output:** Explicit accept/reject rationale, unresolved risks and mitigations.

### Gate 5 — Validate and scope delivery

Test representative prototypes or live workflows, then sequence work into independent increments (continuity, album/queue, audio transparency, discovery polish).

**Output:** Recommended direction, measured or observable acceptance criteria, phased design brief for the development agent.

## 13. Questions the EGM should challenge

1. Does Cadence need a mini-player everywhere, or a stronger playback-context model with a different UI expression?
2. Should queue ordering be expressed at the **album** level, **track** level, or both?
3. How should a single album with many versions be represented to avoid format-driven catalog duplication?
4. Is tapping an album ever a Play action, or is album selection always navigational?
5. What should the mobile UI do when **metadata is absent**, rather than presenting an incorrect or fabricated artist?
6. What happens when the device is connected and ready, but audio is not loaded or the output is not the intended device?
7. Which fidelity badges are useful at a glance, and which belong in an expandable signal-path explanation?
8. Which user-initiated actions require network/disk access during playback, and how is the audio-hygiene contract upheld?
9. How is queue/version identity preserved across curation commits, file renaming and remote reconnects?
10. Which promising competitor interactions would be **wrong for Cadence** because of its local-first/audiophile constraints?

## 14. Definition of done for the brainstorm

The EGM session can transition into formal UX design **only when** it has produced:

- [ ] Prioritized, evidence-labeled problem statements, separating observation from hypothesis.
- [ ] At least three comparable **current-state** journeys and their proposed **target-state** alternatives.
- [ ] Cross-device behavior definitions for navigation, playback, queue and device actions.
- [ ] Agreement on edition/version selection, album/track attribution and queue identity semantics.
- [ ] Explicit audio-hygiene, state ownership and no-silent-mutation checks.
- [ ] Decision log listing accepted options, rejected alternatives, tradeoffs and open risks.
- [ ] A limited Phase 1 proposal with acceptance criteria, test cases and non-goals.

**Do not produce an implementation-ready design on the strength of the three screenshots alone.** The first outcome should be a defensible product direction with its assumptions exposed.

---

## Suggested opening prompt for `/egm-brainstorm`

> Use the attached **Cadence — Unified Listening Journey** concept brief as the input for product and UX brainstorming. Focus on **user journeys**, not visual polish or implementation. First evaluate the problem framing, observed frictions, assumptions and Cadence non-negotiable invariants. Benchmark Roon, Audirvāna and Volumio at the task/interaction level, explicitly distinguishing verified behavior from speculation. Explore at least three credible journey models with tradeoffs and failure modes. **Do not treat the proposed mini-player, album-detail flow or queue grouping as preapproved solutions.** Work one decision gate at a time; preserve Cadence's audio hygiene, authoritative desktop session, transparent user actions and deliberate version/metadata governance. Start with **Gate 1: Problem and journey boundaries**, and propose what evidence should be gathered before moving to Gate 2.
