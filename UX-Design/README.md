# UX Design: Unified Curate & Audit Cockpit Mockup

## Overview
This directory contains the standalone interactive TSX mockup for the **Unified Curate & Catalog Cockpit**, unifying Cadence's metadata audit, autonomous consensus curation, offset alignment, and behavioral learning engine into a single human-centric workspace.

- **Mockup Component:** [`UnifiedCurateCockpitMockup.tsx`](./UnifiedCurateCockpitMockup.tsx)
- **Concept Brief & RFC:** [curation_coherence_concepts_brief.md](file:///C:/Users/Mathan/.gemini/antigravity/brain/9134cf7d-a46f-465b-8ad2-f3822f707451/curation_coherence_concepts_brief.md)

---

## Key Interactive Features in the Mockup

### 1. 3-Tier Operational Segmented Control (Apple HIG standard)
- **Tier 1: Auto-Staged (`tier1`)**
  - Displays albums meeting high-confidence ($\ge 0.85$) 3-of-4 provider consensus (Local, Apple Music, MusicBrainz, Gemini AI).
  - One-click **"Commit All (N)"** button triggers non-blocking background commit queue with progress HUD.
  - Drill-down review with "Reject to Tier 3" button.
- **Tier 2: Smart Aligned (`tier2`)**
  - Simulates the *Ranga (1982)* CD rip case with tracks indexed `#6` to `#10`.
  - Visual **Offset Bridge** showing local tracks mapped directly to provider tracks `#1` to `#5`.
  - Displays side-by-side local track name, canonical track title, and authentic singers (*Malaysia Vasudevan, Vani Jairam, P. Susheela, S. Janaki*).
- **Tier 3: Needs Review (`tier3`)**
  - Displays low-confidence or split-vote albums (*Mouna Raagam Rare Cassette*).
  - Interactive **Grounding Hint Input**: Paste any URL or query, click **Anchor**, and observe live promotion to Tier 1.

### 2. Behavioral Learning Engine ("Learned Rules")
- Accessible via the **Learned Rules** tool button in the top toolbar.
- Shows transparent mappings (e.g. `A.R. Rahman` $\rightarrow$ `A. R. Rahman`, `Illayaraja` $\rightarrow$ `Ilaiyaraaja`, `feat.` $\rightarrow$ `&`).
- Users can inspect occurrence frequency, active state, and revoke or delete rules with a single click.

### 3. Catalog Health Telemetry Drawer
- Expandable side drawer summarizing uncurated albums, missing artwork scans, and conflicting artist spellings.

### 4. Audiophile Transport Guard Simulation
- Toggle button in the header toolbar simulating Windows WASAPI Exclusive playback state (`Engine Idle` vs `Playing (Bus Silent)`).
- When active, batch commits are safely deferred to maintain absolute storage bus silence during audio playback.
