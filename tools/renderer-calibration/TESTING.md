# Renderer calibration test evidence

Journeys were derived from the requested standalone calibration workflow. The tests exercise synthetic TCP records and a mocked two-capture command flow.

- RED: `python -m unittest discover -s tools/renderer-calibration -p 'test_*.py'` failed because `calibrate.py` was absent (commit `a8481ef`). GREEN: the initial three tests passed after implementation (commit `aa49585`).
- RED: the inconsistent-rate test failed because an incomplete transfer was accepted (commit `d3c92ba`). GREEN: the same suite passed after rate validation (commit `7147c5a`).
- The current suite additionally checks sender/receiver direction, non-overwrite behavior and two-capture JSON output. Run the command above for the current result.
- Coverage percentage was not measured: the Python `coverage` module is not installed. No live TShark, platform packaging, engine JSON import, physical renderer, optimized playback, PCM/DSD transition, or NIC/CPU/GPU measurements were run. The mocked workflow does not prove capture privileges, packet fidelity or acoustic stability.
