# UX Design: Unified Curate & Audit Cockpit Mockup (2-Tier Architecture)

## Overview
This directory contains the standalone interactive TSX mockup for the **Unified Curate & Catalog Cockpit**, unifying Cadence's metadata audit, autonomous consensus curation, offset alignment, and behavioral learning engine into a streamlined **2-Tier architecture**:

- **Tier 1: Auto-Staged (Consensus & Batch Commit):** Albums meeting $\ge 0.85$ consensus across Local, Apple Music, MusicBrainz, and Gemini AI. Staged with Tier 1 tag, ready for 1-click batch commit.
- **Tier 2: Guided Reconciliation Table (Merged Tier 2 & Tier 3):** Master 4-way table reconciliation for any release requiring review, offset alignment, or human steering.

- **Mockup Component:** [`UnifiedCurateCockpitMockup.tsx`](./UnifiedCurateCockpitMockup.tsx)
- **Concept Brief & RFC:** [curation_coherence_concepts_brief.md](file:///C:/Users/Mathan/.gemini/antigravity/brain/9134cf7d-a46f-465b-8ad2-f3822f707451/curation_coherence_concepts_brief.md)

---

## The 4-Way Reconciliation Table Format

Every tag is presented across 5 columns:
| Field | Local File Tag | Apple Music Master | MusicBrainz Archive | Gemini AI Master | Selected Output |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Album Title** | Ranga CD RIP | Ranga (Original Motion Picture Soundtrack) - EP | St. Ranga | Ranga (Original Motion Picture Soundtrack) | **Ranga (Original Motion Picture Soundtrack)** [AI] ✏️ |
| **Album Artist** | Unknown Artist | Shankar Ganesh, Vaalee & Malaysia Vasudevan | Bloodnut | Shankar Ganesh & Vaalee | **Shankar Ganesh & Vaalee** [AI] ✏️ |
| **Composer** | Shankar-Ganesh | Shankar Ganesh | Bloodnut | Shankar Ganesh | **Shankar Ganesh** [Apple] ✏️ |
| **Year** | 1982 | 1982 | 2017 | 1982 | **1982** [Apple] ✏️ |
| **Cover Art** | None | [3000px HD Thumb] | [CAA 500px Thumb] | [AI Verified Thumb] | **[Selected Preview]** ✏️ URL |
| **Genre** | Soundtrack | Tamil Cinema / Soundtrack | Film Score | Soundtrack | **Tamil Cinema / Soundtrack** [Apple] ✏️ |

### Track-Level Reconciliation Table:
Each track row displays:
| # | Local File | Apple Music Track | MusicBrainz Track | Gemini AI Track | Selected Track & Singers |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **#6 ➔ #1** | Pattukottai (`06 - Pattukottai.wav`) | Pattukotta Ammalu *(Shankar Ganesh, Vaalee, Malaysia)* | Pattukottai *(Bloodnut)* | Pattukotta Ammalu *(Malaysia Vasudevan)* | **Pattukotta Ammalu** *(Malaysia Vasudevan)* ✏️ |

---

## Interactive Capabilities in this Mockup

1. **Cell-Click Source Adoption:**
   - Click any provider cell (`Apple Music`, `MusicBrainz`, `Local`, `Gemini AI`) in either the album table or track table to instantly select that candidate.
2. **Inline Manual Editing (`✏️`):**
   - Click the edit icon next to any tag (or cover artwork) to open inline input and type a custom override (or paste a custom image URL).
3. **Sequence-Aware Offset Bridge:**
   - Displays CD rip offset mapping (e.g. Local tracks `#6`–`#10` mapped directly to provider tracks `#1`–`#5`).
4. **Bulk Tracklist Adoption:**
   - Quick-action buttons to adopt `"All Apple Music"`, `"All Gemini AI"`, or `"Reset Local"` across all tracks with one click.
5. **Learned Rules Inspector:**
   - Header button opens the learned spelling and delimiter conventions modal (`A.R. Rahman` $\rightarrow$ `A. R. Rahman`).
6. **Transport Purity Guard Simulation:**
   - Click the audio engine status button in the header to simulate WASAPI Exclusive playback pausing background tag writes.
