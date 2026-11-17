# Album artwork import and scan audit

Date: 2026-11-17. Scope: current working tree, including existing uncommitted Playback Engine work. Findings in that work do not establish that the same code is in a released version.

Method: source inspection of catalogue snapshot migration, Windows legacy migration, current Playback Engine import/scanning, older desktop scanning, browser importer, and artwork projection/loading. No production database, music files, or application state were accessed. No runtime reproduction or application tests were run. Severity reflects user-visible impact inferred from control flow.

## Findings

### 1. High: catalogue snapshot import drops artwork references and does not import image blobs

`src-tauri/src/core_runtime/migration.rs:403` copies releases without `front_cover_url` or `backdrop_url`. It copies track `has_embedded_art`, `mtime`, and `file_size`, but has no transfer into `engine_artwork`.

The engine serves images exclusively from `engine_artwork` (`library.rs:842`), and projects `hasCoverArt` from the track flag (`library.rs:877`). A fresh imported catalogue can therefore advertise artwork that the image endpoint cannot provide. A folder-only cover may have no embedded-art flag and no UI artwork sentinel at all. An unchanged quick scan skips image reconstruction (finding 3).

Reproduction: import a snapshot containing embedded-only artwork, or release artwork URLs, into a fresh Core database; inspect the album art, then run quick scan without modifying the tracks. A full scan can rebuild supported local/embedded images, but cannot restore an online-only artwork choice omitted by migration.

### 2. High: Windows legacy artwork migration silently loses cache copies on a fresh database

`src-tauri/src/core_runtime/windows_engine.rs:636` copies cached release images into `engine_artwork`, ignoring each insert result. `import_snapshot_into_core` initializes the target with `AppDb::new`; `db/schema.rs` does not create `engine_artwork`. That table is created later by the runtime library initialization (`library.rs:96`). The fresh-database migration path therefore has no destination table for these inserts, yet can report import success. An already-initialized target may avoid this failure.

Existing Windows migration coverage checks track/playlist counts and watched folders, without supplying or asserting migrated artwork.

Reproduction: supply a legacy catalogue with a cached release image and migrate to an empty engine data directory. Check for the corresponding image blob after initialization, rather than relying on the migration success result.

### 3. High: quick scan ignores changes to artwork dependencies and cannot repair missing cached art

Both `src-tauri/src/core_runtime/library.rs:743` and `src-tauri/src/scanner/engine.rs:611` return/continue when only the audio file's second-resolution mtime and size match. Neither checks cover image changes, missing cached images, or album sidecar changes first. The older scanner reads the album sidecar after that skip.

Reproduction: scan an unchanged album; add/replace `cover.jpg`, or change its artwork sidecar; quick scan. Artwork discovery is skipped. This also prevents a quick scan repairing finding 1.

### 4. High: image decode failure stops fallback even when another valid image exists

`src-tauri/src/core_runtime/library.rs:793` selects the first embedded picture, or the first readable named folder image, and only then calls `compress_art`. A failed decode becomes `None` through `.ok()`; it does not try another embedded picture or folder candidate. A corrupt embedded image blocks a valid `cover.jpg`; corrupt `cover.jpg` blocks valid `folder.jpg`. Valid images outside decoder limits can cause the same fallback failure. This affects initial import and full scans.

Reproduction: use an invalid embedded image plus valid folder art, or invalid `cover.jpg` plus valid `folder.jpg`; full scan and inspect `hasCoverArt` and the image endpoint.

### 5. Medium: embedded image selection ignores front-cover type; release image depends on track order

The engine (`library.rs:794`), older artwork IPC (`commands/scanner.rs:206,214`), and browser importer (`libraryImporter.ts:375`) select the first picture, without preferring the front-cover picture type. A booklet/back-cover/artist image preceding the actual cover is displayed instead.

Additionally, the engine upserts the same release image on every track with decoded artwork (`library.rs:829`). When tracks disagree, the last processed track wins. An incremental scan of one changed track can replace the whole album's image.

Reproduction: put a back cover before the front cover in the picture list; separately scan an album whose tracks contain different covers and change which track is processed last.

### 6. Medium: folder discovery is narrow, inconsistent, and does not search the album parent for disc tracks

The engine checks only `cover.jpg`, `cover.png`, `folder.jpg`, `folder.png`, and `front.jpg` in the audio file's immediate parent (`library.rs:797`). It ignores `.jpeg`, `front.png`, `album.jpg`, and other naming variants. Exact casing matters on Linux. The older scanner and artwork IPC use different lists (`scanner/engine.rs:115`, `commands/scanner.rs:226`).

For `Album/CD1/track.flac` with `Album/cover.jpg`, neither native scan searches the album parent for the cover. The older scanner adjusts its display folder name for disc folders but still discovers artwork in the immediate parent. The engine also does not read `cadence-album.sidecar.json`, unlike the older scanner.

Reproduction: use folder-only artwork as `cover.jpeg`, `front.png`, Linux `Cover.jpg`, an album-parent cover, or an artwork sidecar. Compare import and full-scan results between the two native paths.

### 7. Medium: older full scan preserves broken stored artwork ahead of valid folder artwork

`scanner/engine.rs:791` prioritizes sidecar, then existing database cover, then local images. It checks only whether a database value is `Some`, without validating usability; even an empty string prevents fallback. A deleted cache path or obsolete URL therefore survives full scan while a valid folder cover is available. Background thumbnail persistence updates only NULL/empty release covers (`db/operations.rs:1632`), so a nonempty stale path also resists that repair path.

Reproduction: set a release cover to a nonexistent path, retain a valid `cover.jpg`, and full scan through the older desktop scanner.

### 8. Medium: browser importer can assign another album's artwork

`src/services/libraryImporter.ts:393` looks up a full folder path, then an unscoped folder basename, then the first image anywhere in the import. This explicitly assigns unrelated art when an album has no own image. Duplicate directory basenames also collide. Image preference is input-order dependent: each preferred-looking filename can overwrite an earlier selection.

Reproduction: browser-import two albums together, with folder art for only the first and no embedded image for the second. The second receives the first album's image. This is a legacy/browser path; the current Add Music modal routes through the engine, so this finding alone does not explain current engine imports.

### 9. Medium: full engine scan leaves obsolete image blobs after artwork removal

`library.rs:829` only writes image blobs when decoding succeeds; there is no corresponding deletion when artwork is absent. It updates the current track flag to false, but retains the old release blob. With an album where only a different track retains artwork, removing art from the formerly winning track can leave the old image served after a quick scan of that changed track. With all artwork removed, the catalogue may stop advertising the cover while a direct image request still returns the obsolete blob.

Reproduction: scan two tracks with different images; remove the winning track's picture; quick scan that change and inspect both catalogue flags and the release image endpoint. Also remove all pictures and full scan.

## Repair and verification priorities

Address migration completeness and explicit migration failure reporting first. Then separate quick-scan audio freshness from artwork freshness, including cache reconstruction for imported catalogues. Share deterministic artwork discovery across paths: front-cover preference, decode-and-continue fallback, scoped album/disc folder resolution, and explicit sidecar policy. Define release-level selection and removal behavior so a per-track scan cannot leave an arbitrary stale cover.

Targeted regression cases should cover each reproduction above, PNG/JPEG embedded art, DSF/DFF artwork, fresh versus existing target databases, and catalogue flags matching image endpoint availability. Verify that all extraction and cache repair remains behind the existing playback/cooldown I/O gates. Real library and playback validation remains outstanding.

No runtime code was modified. Any implementation affecting parsers, library I/O, or background work needs the repository Audiophile Impact Assessment and its applicable approval gate before changes.

## Self-evaluation

Overall 4.0/5. Accuracy 4: findings are traced to source, but not runtime-reproduced; improve with fixture-based execution. Completeness 4: current and older import/scan paths are covered, but affected users' versions and library samples are unknown; improve with an affected-release comparison. Clarity 4: paths and concrete symptoms distinguish the findings, though nine findings require a longer report; keep the user-facing summary shorter. Actionability 4: reproduction and repair priorities are provided, with fixes and executable regressions outside this analysis; use these cases for the follow-up implementation. Conciseness 4: detail is retained for review, while closely related source-selection issues could be grouped further. No critical evaluation gaps. Self-check: the user should be able to assess the reported bugs while seeing the limits of static evidence. Verdict: deliver the audit; validate against fixtures before claiming a fix.
