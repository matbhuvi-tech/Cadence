# UPnP delivery inspector — implementation and validation

2026-11-21. Branch: `feat/upnp-delivery-inspector`.

## Scope and acceptance

Journeys came from the user's approved design: a quiet pacer status pill beside
the active output, an on-demand sender delivery graph, and an engine-specific
pacer toggle. Measurements must preserve Cadence's playback hygiene.

- The pill appears for an active Core UPnP output. It reads the selected engine,
  including a local Windows Playback Engine, rather than a separate desktop
  audio manager. WASAPI outputs do not receive delivery heartbeat payloads.
- One initial summary request is followed by summaries on the existing ten-second
  engine event heartbeat. There is no new closed-inspector polling timer.
- Opening the inspector starts an at-most-60-second capture, with 600 preallocated
  100 ms bins. Only an open, visible inspector retrieves batches every five seconds.
- Closing, freezing, hiding, pausing or switching away stops capture. A late start
  response is stopped without publishing. An abandoned capture expires after
  60 seconds. Starting a new audio HTTP stream invalidates old history; the user
  can capture again. Capture IDs prevent an old controller stopping a newer capture.
- The graph uses Mbps, step geometry and complete 100 ms intervals. It displays
  sender socket-write completions, intended pacing rate, track average, and
  excess-delay markers. No interpolation invents data between samples.
- The active engine confirms pacer changes. Errors preserve the observed setting;
  no automatic recommendation changes the pacer. Linux/Core now supports the same
  explicit toggle by bypassing intentional pacing sleeps while retaining pause,
  cancellation and socket safety behavior.

## Audiophile impact assessment

| Area | Implementation |
|---|---|
| Disk | All measurements stay in RAM. No history persistence, database reads, library reads, log flushing or speed probes were added. |
| Network | Existing ten-second heartbeat carries a compact summary only for UPnP outputs with event subscribers. Inspector queries are five seconds apart and bounded by the capture lifecycle. Full history is never included in heartbeat events. |
| Threads | No thread or sampling timer was added to the sender. MMCSS, affinity, sleep deadlines, socket buffers and audio byte slicing remain under existing control. Control-thread code performs allocation and serialization. |
| Memory | History has 600 fixed atomic bins (19,200 bytes of bin storage, plus control fields) per metrics instance, created outside the sending loop. Audio buffer locking and working-set calculations are unchanged. |
| Hot path | With capture closed, the history writer checks an atomic flag without reading the clock or computing diagnostic rates. Open capture uses monotonic timestamps, local accumulators and tagged atomic stores; it does not allocate, lock, log or serialize. |
| UI | State is isolated in a memoized pill. The chart is static SVG with discrete updates; there is no animation loop. Hidden inspectors stop collection and retrieval. |

Successful audio writes are counted when the Windows pacer is off; they are no
longer incorrectly treated as metadata requests. Actual metadata remains excluded.

## Interpretation safeguards

`Stable` describes the latest sender observation window. It does not prove NIC
departure timing, receiver packet spacing, actual streamer buffer fill, DAC jitter,
or audible improvement. No renderer-buffer countdown is exposed.

Startup/new HTTP streams and missing/stale observation windows remain `Assessing`.
Receiver window pressure alone is not classified as network congestion. A sustained
rate deficit must also have stall/impairment evidence over two observation windows
before `Falling behind` appears. The 95% deficit threshold is provisional and needs
hardware calibration, especially for compressed/VBR tracks and renderer buffering.

Delay markers represent at least 25 ms **beyond the preceding chunk's intended
interval**. A 16 KiB CD-quality write naturally occurs about 93 ms apart and must
not itself trigger a late marker. Empty bins remain visible as zero sender rate;
buffered playback can legitimately continue while there are no sender writes.

## TDD evidence

RED checkpoint `8a3023e` added the contract and bounded-history tests. Running
`node --import tsx --test src/test/testUpnpDelivery.ts` failed because the requested
`upnpDelivery` implementation was absent. The native `upnp_delivery` integration
target failed with unresolved import of the same not-yet-implemented module.
The low-bitrate regression additionally failed with absent `max_delay_us` before
the distinction between intentional spacing and excess delay was implemented.

| Guarantee | Validation actually run | Result |
|---|---|---|
| Status distinguishes startup, receiver pressure, local delays and repeated delivery deficits | `npm run test:upnp-delivery` | 11 tests pass |
| Wire bounds, active identity, RPC failure handling and capture start/stop races | Same target | Pass |
| Capture lifecycle and status coverage | `node --import tsx --experimental-test-coverage --test-coverage-include=src/core/upnpDelivery.ts --test-coverage-include=src/services/upnpDeliveryCapture.ts --test src/test/testUpnpDelivery.ts` | 100% lines, 96.77% branches, 86.67% functions across these two new modules |
| Native capture opt-in, expiry, freeze, restart and low-bitrate spacing | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --test upnp_delivery` | 3 tests pass |
| Real control endpoint identity rejection, capture and Linux/Core pacer toggle | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --test core_dragonfish_packaging_test upnp_delivery_control -- --test-threads=1` | 1 test passes |
| Existing Windows/Core pacing state regressions | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features engine-audio --lib upnp -- --test-threads=1` | 22 tests pass |
| Optimized PCM/DSD bodies, HTTP ranges, cancellation and allocation safety | `cargo test --manifest-path src-tauri/Cargo.toml --release --no-default-features --features engine-audio --test core_upnp_zero_alloc_test --test upnp_delivery --test core_upnp_session_test` | 14 tests pass; zero allocations, allocated bytes and deallocations in active sender loops with capture closed and open |
| Actual React component, RPC client, graph, Freeze, toggle/failure, Escape, 375px bounds, visibility cancellation | `npm run test:upnp-delivery-ui` | 10 browser checks pass using isolated synthetic telemetry |
| Engine identity/session and endpoint regressions | `npm run test:core-services`, `npm run test:core-session-protocol`, `npm run test:endpoint-routing` | 32 + 2 tests and routing regression script pass |
| Desktop/PWA production build and TypeScript | `npm run build` | Pass; existing bundling warnings |
| Windows Playback Engine release binary | `cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features --features engine-audio --bin cadence-engine` | Pass; binary at `src-tauri/target/release/cadence-engine.exe` |
| Static lint | `npm run lint`, plus targeted `oxlint` on changed TypeScript modules and QA script | Repository command exits 0 with existing warnings; targeted files have no warnings |

Browser screenshots and machine-readable evidence are generated locally under
`test-results/upnp-delivery/`. The browser harness uses a synthetic engine and
temporary Chromium profile; it never contacts a real renderer or music library.
These screenshots have no established visual regression baseline.

## Hardware verification still required

Release loopback tests are not physical streamer or Linux-kernel measurements.
TrueNAS/Linux execution, actual Ethernet/Wi-Fi packet timing, CPU/GPU impact,
NIC activity, audible dropouts, and host scheduling overhead remain unverified.
No claim of zero performance impact or improved sound quality is made.

Before merging, update both the desktop and the serving engine from this branch.
Play representative PCM and DSD material and compare:

1. Inspector closed, opened for 60 seconds, frozen, and closed again.
2. Idle/pause/resume, seeking, new tracks, HTTP continuations and engine switching.
3. Pacer on and off, on Ethernet and Wi-Fi, with and without competing traffic.
4. CPU/GPU, library-drive I/O, network activity and observed dropouts, compared with
   the prior approved release. Packet capture is useful for calibration but not
   required for the user-facing inspector.

The implementation has not been merged or pushed. User playback verification is
required by `.agents/rules/Git.md` before the separate merge approval step.

## Self-evaluation

Overall 4.2/5; ready for user verification with the hardware limits above.

| Axis | Score | Evidence / remaining improvement |
|---|---|---|
| Accuracy | 4 | Sender semantics, units, low-bitrate spacing and allocation behavior are tested; physical-route timing is unverified. |
| Completeness | 4 | Pill, bounded capture, both engine paths, toggle and QA are implemented; hardware calibration remains. |
| Clarity | 4 | UI distinguishes sender observations from streamer timing; unusual buffering patterns still need real-device feedback. |
| Actionability | 5 | Reproducible commands, browser QA and an explicit local verification checklist are included. |
| Conciseness | 4 | Details are kept in this report; cross-platform validation needs several commands. |

Highest-impact follow-ups are hardware timing/overhead validation and status
threshold calibration. Self-check: the user should agree that the feature is
reviewable while its audiophile performance still needs hardware evidence.
