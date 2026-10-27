# Stage 6: Comprehension Test Report

*   **Target Document:** `docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md`
*   **Evaluator:** Naive Reader (`egm-comprehension`)
*   **Evaluation Standard:** `resources/document_standards/re-implementation-standard.md`
*   **Date:** 2026-10-27

---

## Executive Assessment

The document is well-written, logically structured, and provides clear architectural intent. However, applying the Zero-Assumption Rule reveals several unstated contracts and edge-case ambiguities where an implementer would be forced to make independent design assumptions during implementation.

---

## Findings

### Finding 1: Unstated ID Contract for `user_split_releases` on Grouped Releases
*   **Severity:** 🟡 Major
*   **Affected Scope:** Section 4.B (`User Split Overrides via SQLite`, lines 155–166)
*   **Discrepancy Description & Rationale:** 
    The document states:
    > *"Triggering `Split Multi-Disc Release` inserts the `release_id` into `user_split_releases`."*
    
    In Cadence, multi-disc box sets are typically composed of multiple discrete underlying `Release` records in SQLite, each with its own UUID. When grouped in the UI, does the UI synthesize a composite release ID (e.g., `mbid:<mbid>` or `group:<normalized_title>`), or does it use the primary disc's release UUID? If a composite ID is written, what does the grouping query match against? If individual release UUIDs are used, which one is written?
*   **Required Contract:** 
    Specify whether `release_id` in `user_split_releases` stores:
    1. The MusicBrainz Release Group ID (`musicbrainzReleaseGroupId`) for Tier 1 groupings.
    2. A deterministic normalized composite key (e.g., `${normalized_artist}::${normalized_title}`) for Tier 2 groupings.
    3. Or all constituent member release UUIDs.

---

### Finding 2: Undefined Lazy-Loading Boundary for In-Memory Folder Tree Filtering
*   **Severity:** 🟡 Major
*   **Affected Scope:** Section 3.B (`In-Place Folder Tree Filtering`, lines 139–145) & File 12
*   **Discrepancy Description & Rationale:** 
    The document states:
    > *"Filtering operates strictly against the in-memory array of loaded tree nodes: matching child branches are retained and expanded, while non-matching siblings are dimmed. No network queries or recursive filesystem disk traversals are performed over SMB shares."*
    
    In virtual tree views, child directories are typically loaded lazily upon expanding a folder node to avoid walking massive directory trees at startup. If a user enters `⌘F` to search for a subfolder that resides inside an unexpanded root folder, will it match? A reader must guess whether the filter is strictly confined to currently expanded/cached nodes, or if the tree is fully pre-indexed into memory during catalog scan.
*   **Required Contract:** 
    Explicitly clarify whether `FolderTreeExplorer` operates on an already pre-loaded directory manifest in memory, or if `⌘F` filtering is explicitly limited to nodes that have already been expanded/cached in memory, with a visible UI empty state/note explaining that collapsed unexpanded subtrees are not searched without network traversal.

---

### Finding 3: Ambiguous Sequence Rule for Incomplete Multi-Disc Box Sets
*   **Severity:** 🟡 Major
*   **Affected Scope:** Section 4.A (`Grouping Logic & Hierarchy`, lines 152–153)
*   **Discrepancy Description & Rationale:** 
    The rule states:
    > *"valid, sequential `discNumber` (`1..totalDiscs`) where `totalDiscs > 1` or multiple disc numbers exist for the release."*
    
    What is the expected behavior if a user's library contains only Disc 1 and Disc 3 of a 3-disc release (missing Disc 2)? Does "sequential" require a strict unbroken sequence `[1, 2, 3]`, causing the set to fail Tier 2 grouping and render as scattered albums, or does it mean each constituent album has `discNumber > 0` and `discNumber <= totalDiscs`?
*   **Required Contract:** 
    Clarify whether partial/sparse disc sets (e.g. discs 1 and 3 present) group together into a multi-disc card or remain separate until all sequential discs are present.

---

### Finding 4: Schema Origin of Candidate ID in Artwork Selection
*   **Severity:** 🟢 Nit
*   **Affected Scope:** Section 6.B (`Curate Mode & Inspector Layout`, lines 240–245) & File 13
*   **Discrepancy Description & Rationale:** 
    The document specifies changing radio selection from `selectedArtwork === art.url` to `selectedArtworkId === art.id`. The reader must know if `art.id` is an existing field on `ArtworkCandidate` or if candidate objects must be constructed with a synthetic identifier (such as `art.source: 'embedded' | 'directory' | 'apple_music'`).
*   **Required Contract:** 
    Confirm whether `id` exists on `ArtworkCandidate` or explicitly state that `art.source` serves as the unique candidate identifier.
