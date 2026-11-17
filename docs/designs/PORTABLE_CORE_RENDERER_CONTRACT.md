# Portable Core renderer selection: proposed contract and boundary

Status: implementation in progress. Baseline: e7ae155. The existing v1 API and
`rs130-upnp` output remain unchanged until compatibility is verified.

## Implemented and known limitations

The bridge retains the URI established by a successful Core transport command.
Before dispatching Stop, it queries the renderer and sends Stop only when the URI
matches and the reported transport is playing, paused or transitioning. Missing,
failed or ambiguous observations fail closed. Shutdown without a Core session no
longer sends Stop. The media-server shutdown order and audio pipeline are unchanged.

The URI check and Stop are separate UPnP requests: another controller can replace
the transport between them. This is not atomic and cannot guarantee protection
against concurrent external controllers. Persistent general UDN selection, fresh
takeover validation and three-state capability handling are not yet implemented.
The preliminary Sink protocol-info classifier exists and has a focused unit test,
but it is not connected to discovery, selection or admission. The legacy RS130
profile is derived from the TrueNAS/RS130 DSD256 and CD capture observations
described in `core_runtime/upnp_session.rs`; this does not establish capability
evidence for other renderers.

The original 22 tests and two ownership tests passed serially on Windows. One
parallel run failed while reading an HTTP response in the concurrency fixture.
The rejected connection had unread request bytes, producing a Windows TCP reset
and a truncated 503. The fixture now sends no request on the connection rejected
before request parsing; 20 parallel suite runs passed. Linux and hardware acceptance
are pending.

## Slice 1 implemented: authenticated renderer discovery

`renderer.discover` (v1, additive) is served by `core_runtime/renderer_discovery.rs`
behind the existing `/v1/` token check. The request is a closed field set
(`protocolVersion`, `operation`, `engineId`, `libraryId`, optional `requestId`); it
accepts no URL or address. One bounded SSDP search is run on request only. Each
`LOCATION` must be an IPv4 literal equal to the datagram source and private or
link-local; redirects are refused; responses (128 KiB), datagrams, candidates (16) and
total time (4 s) are bounded; DOCTYPE/ENTITY is rejected; control URLs must stay on the
same `ip:port`. Renderers are identified by validated UDN (duplicates collapsed) and
must expose AVTransport. Capability evidence is read-only ConnectionManager
`GetProtocolInfo` only (no AVTransport action can be built by the module) and is
reported per `pcm`/`dsd` as `supported`, `unsupported` or `unknown`; no evidence is
`unknown`. Controllers never receive addresses or URLs.

Temporary policy, to be re-evaluated with performance data: discovery is refused with
`discovery_deferred` (`reason`: `playback_active`, `cooldown_active` or `rate_limited`,
with `retryAfterMs` where applicable) while Loading, Playing or Paused, during the
30-second post-playback cooldown, and within 5 s of the previous run. Discovery holds
the runtime lock for at most the bounded duration while idle. It runs on the control
thread with no new threads, priorities, timers or locked memory. `DragonfishRenderer::apply`,
`supports_extension`, the pacer and the audio path are untouched; the Slice 1 result is
not yet used for selection or admission. The Windows desktop engine does not install a
discovery backend yet. Selection (Slice 2) will hard-reject while not idle.

## Contract

- Authenticated controllers request bounded, explicit discovery; responses identify
  validated MediaRenderers by stable UDN, include a display label and availability,
  and distinguish advertised format support from unknown support. Discovery is a
  read-only operation and does not issue transport commands. No background scan is
  introduced. A stale identifier is rejected rather than matched by address.
- An authenticated selection mutation includes the chosen UDN, a command ID and
  expected authoritative revision. It is rejected if stale, unavailable or if the
  current owned session cannot be safely switched. Persist the selected UDN in
  application data atomically; never substitute a different device when it is offline.
  A refresh can reconnect the same UDN after its address changes.
- The Core publishes selection and availability as authoritative state; controllers
  observe it through snapshot/events. Preserve the existing `rs130-upnp` v1 output
  projection for legacy clients and expose richer selection via an additive,
  explicitly negotiated extension. Existing pinned UDN acts as the initial selection
  only when no newer explicit selection exists; retain existing deployments.
- Observe external playback without issuing Stop, SetAVTransportURI or Play. Existing
  `forceTakeover` is an explicit user action, and must be checked against a fresh
  renderer state before attempting takeover. Unknown state must fail closed. A
  selection alone never takes over external playback. Shutdown or deselection may
  stop only a session the Core can establish it owns.
- DSD support is unknown unless supported by reliable advertised or verified
  capability evidence. No transcoding, resampling or payload modification is added.
  Capability queries must not turn absence of evidence into an affirmative claim.

## Affected files and sequence

1. Add bounded, service-validating discovery and test fixtures in a separate
   `core_runtime` module, avoiding changes to the packet pacer and media handler.
2. Extend `core_runtime/dragonfish.rs` with selected-UDN persistence, explicit
   discovery and selection handlers, and compatibility migration. Wire changes into
   the authoritative session, maintaining the existing authentication boundary.
3. Extend `core_session` protocol, state and event projection additively, with
   command revision/idempotency and unknown-operation compatibility tests; update
   controller types only as needed. Preserve queue ownership.
4. Verify multiple fixtures, selected-device loss and same-UDN return, stale and
   unauthorized requests, concurrent controllers, external playback, legacy
   RS130 behavior and capability uncertainty. Then implement portable packaging,
   release checks and documentation, and run separate Linux/hardware acceptance.

## Playback boundary and outstanding work

`HeadlessCoreRuntime::shutdown` dispatches `RendererAction::Stop`, but the bridge now
verifies the established URI before sending UPnP Stop as described above.
`DragonfishRenderer::apply` resolves and binds a device on Play, and the current
descriptor's `supports_extension` reports DSD support for all devices. Changing
selection without addressing these dispatch paths would risk stopping external
playback, selecting a different device, or misrepresenting capability. The minimum
safe guard has been added at the renderer dispatch boundary; no change
to pacing, buffering, payload, queue ownership or scheduler is intended.

## Validation and risk

Existing Windows baseline: 9 packaging, 7 headless and 6 simulated UPnP tests passed.
This does not validate Linux memlock/cpuset behavior, multi-architecture builds,
physical PCM/DSD playback, pacing metrics or mobile pairing. Those remain separate
release gates. The one-eligible-CPU partition shares control and pacer and cannot
provide isolation. Preserve IPC_LOCK/memlock and report insufficient admission
explicitly. Never label Phase 1 complete before a published artifact and real-device
acceptance exist.
