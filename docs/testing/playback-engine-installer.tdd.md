# Guided Playback Engine installer verification

Journeys: a Linux user accepts suggested release and address, selects storage, and starts the engine; a TrueNAS user creates an app managed by TrueNAS; an existing installation is protected from replacement.

- RED: `python -m unittest discover -s deploy/playback-engine -p test_installer.py` failed because `install.py` did not exist (checkpoint `8e720c8`).
- GREEN: the same command passed 9 tests on Windows, including an actual Docker Compose configuration round trip. On Ubuntu WSL, the same suite passed 8 tests with the Docker-specific test skipped because only the Windows Docker CLI was available. Tests cover address/tag validation, storage overlap, existing-install protection, quoted settings, simulated Linux installation, TrueNAS app payload and avoiding NAS package installation.
- `bash -n deploy/playback-engine/install.sh` passed in Ubuntu WSL; `python -m py_compile deploy/playback-engine/install.py` passed.
- Live apt installation, GHCR publication/download, native ARM64, TrueNAS middleware, and playback on a physical renderer have not been tested. These need a published release and suitable hosts. No coverage percentage was measured; the suite exercises the central decisions but mocks system-changing operations.
