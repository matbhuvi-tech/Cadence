# Renderer pacer calibration (experimental)

This standalone Python CLI captures two manually initiated test tracks with TShark and writes a **candidate** `renderer-profiles.json` registry. It does not control playback or elevate itself. Run it on the playback engine host with permission to capture on the selected network interface. Windows requires Wireshark/TShark and Npcap; Linux requires TShark and appropriate capture privileges (for example, run the CLI with sudo where permitted). Python 3.9 or later is required. The same source is intended for Linux amd64/arm64 and Windows, but live capture has not yet been verified on these platforms.

## Run

1. Make sure no unrelated playback is active. Select the generic pacer on the intended engine and renderer. Use test tracks of at least 90 seconds: stereo DSD256 and stereo 44.1 kHz/16-bit WAV. This tool cannot verify the selected files or pacer.
2. Run `tshark -D` with the same privileges and identify the interface carrying traffic between engine and renderer. Obtain their IPv4 addresses, the engine media port, and the renderer UDN.
3. On the engine host, run from an elevated shell, for example:

   ```text
   python tools/renderer-calibration/calibrate.py --interface 1 --sender 192.168.1.6 --renderer 192.168.1.106 --udn uuid:renderer-id --output candidate.json
   ```

   Supply `--port` if the media port differs from 18890, `--tshark` for a non-default TShark path, and `--seconds` for a 45–600 second capture. Capture starts on Enter; start the requested track immediately. Stop playback after each capture and wait at least 30 seconds before confirming the prompt. Do not run unrelated audio while calibrating.
4. The output is a separate file and will not overwrite an existing file. The temporary capture can contain audio payloads; it is deleted on normal exit, but an interrupted or terminated process can leave it in the system temporary directory. Treat captures as private.
5. Review the candidate and validate it on the actual device with fresh PCM and DSD captures and listening tests, including transitions. The component does not validate playback automatically, detect every TCP loss, measure audible stuttering, or establish a renderer's safe buffer capacity. Do not treat it as a verified profile.

## Registry integration

The output uses schema version 1 and exact UDN matching, which has precedence over keyword profiles. It is a **standalone registry**, not a merge with the engine's existing `renderer-profiles.json`. Preserve the existing file and manually merge the generated entry from `profiles` into it; do not replace the registry if other profiles must be retained. The Core reads the registry at startup; restart the engine while idle for a changed file to take effect. Desktop UPnP does not necessarily consume this Core registry.

## Interpretation and limits

The analyzer selects exactly one TCP media connection and rejects short captures and observed transfer rates outside 0.8–1.5 times the expected raw audio rate. It counts TShark-detected retransmissions and receiver zero-window events and calculates the maximum accumulated unique TCP payload above nominal audio consumption before the first detected event. HTTP headers, capture loss, timestamp artifacts, sender-side buffering and receiver consumption are not independently measured; this lead estimate is not a measurement of the renderer FIFO.

The candidate uses half of the smaller observed pre-event lead, capped at 1.2 seconds, and locks the steady-state rate to 1.000x with retransmission backoff. This is a conservative **heuristic**, not a proven optimum or a stability guarantee. The other settings inherit the Core's defaults at deserialization. `learned_from_stress_test` remains false until a separate qualification workflow exists. If no flow-control event is observed, the estimate does not establish a buffer limit. Multiple media connections, seeks, dropped packets, unsupported formats, or packet offload effects can invalidate the result.

## Verification

```text
python -m unittest discover -s tools/renderer-calibration -p test_*.py
```

Automated tests use synthetic records and mocks. Physical capture, capture privileges, Core registry loading, Linux/Windows packaging, and real renderer acceptance remain separate validation steps.
