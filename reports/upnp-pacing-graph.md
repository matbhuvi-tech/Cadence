# UPnP pacing graph

User-approved scope: show equal chunks delivered at regular intervals; do not change pacing algorithms.
Branch: feat/upnp-pacing-graph. Journeys derived from this conversation.

The primary graph now shows maximum early/late deviations around zero, retaining extremes rather than averaging away catch-up writes. Chunk sizes and expected interval ranges are shown above it. Empty capture intervals remain orange. Older engines without the added fields show unavailable timing detail rather than fabricated regularity. The delivery/track Mbps summary remains.

Expected intervals use the preceding write's bytes and active target rate, including rate changes. Only observation code in upnp_delivery.rs changes; no changes to upnp_session.rs, upnp_pacer.rs, stream_tuning.rs or socket configuration.

## Impact assessment

- RAM-only existing 60-second capture, 600 bins, existing five-second reads.
- Seven fixed atomic fields per bin add 33,600 bytes per metrics instance plus fixed writer counters. No hot-path allocations, locks, disk access or logging.
- Extra comparisons and atomic stores occur only during opt-in capture; no added workers, timers, polling or scheduling changes.
- Sender write completions remain distinct from NIC departure and receiver timing. Startup/pre-roll may deviate from nominal target spacing.

## Verification

- RED: new native integration test failed compilation with missing size/timing fields. Checkpoint 00ba8fc.
- GREEN: native upnp_delivery target passes 4 tests, including equal chunks, early/late observations, rate changes, and cross-bin intervals.
- npm run test:upnp-delivery: 13 tests pass, including legacy compatibility and rejection of incomplete/nonfinite timing detail.
- Coverage: upnpDelivery.ts 100% lines/functions, 97.67% branches.
- npm run build passes (existing bundle/dynamic-import warnings). Final npx tsc -b passes.
- Targeted oxlint passes.
- npm run test:upnp-delivery-ui passes lifecycle checks and added assertions for chunk size and expected spacing. Desktop screenshot visually inspected; narrow layout bounds pass. Synthetic fixture, no renderer contacted.
- Optimized release checks pass: 2 core_upnp_zero_alloc_test tests and 4 upnp_delivery tests. Active streaming performs zero heap allocations with capture closed and open (Windows loopback execution; not a physical Linux measurement).

## User verification

Rebuild/update both desktop and serving playback engine, then capture Redbook and DSD playback. Confirm constant chunk-size indication and a narrow timing trace around zero during steady delivery. Inspect startup, freeze and capture-again. Verify playback remains stable. TrueNAS/RS130 timing and CPU impact require hardware verification; local tests do not establish that.

## Self-evaluation

Overall 4.4/5. Accuracy 4: native/frontend/browser evidence passes; physical Linux timing unverified. Completeness 4: graph implemented with compatibility, no deployed binaries. Clarity 5: size and timing are separate measurements with explicit axes. Actionability 5: commands and hardware verification steps supplied. Conciseness 4: report retains test and deployment detail. Improvement: verify actual Linux/RS130 capture and CPU overhead. Self-check: the user should agree this is ready for playback verification, without transport changes.
