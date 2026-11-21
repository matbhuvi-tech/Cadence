# Build from Source

End users do **not** need a development environment — pre-built Windows installers, Linux `.deb`/`.rpm`/`.tar.gz` archives, Android APKs, and OCI images are published on [**GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases).

## Prerequisites

- **Rust toolchain** (MSVC target on Windows, GNU/musl on Linux)
- **Node.js 22+** and **npm**
- **Tauri v2 CLI & NSIS** *(automatically downloaded by Tauri on Windows, needed only for Desktop & Suite installers)*

## Build Commands

```sh
git clone https://github.com/matbhuvi-tech/Cadence.git
cd Cadence
npm install
npm --prefix pwa install
```

### Frontend & Desktop Suite (Windows)

::: code-group
```powershell [Unified Suite Installer]
# 1. Build Desktop NSIS setup (includes React UI + PWA)
npm run tauri:build -- --bundles nsis

# 2. Build standalone cadence-engine.exe & cadence-engine-setup.exe
.\deploy\windows-engine\build-windows-engine.ps1 -RequireInstaller

# 3. Wrap both into Cadence_<ver>_x64-setup.exe
.\deploy\windows-suite\build-windows-suite.ps1 -RequireInstaller
```

```powershell [Frontend Only]
npm run build
npm run lint
```
:::

### Headless Playback Engine (Linux)

```sh
cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features bundled-sqlite --bin cadence-headless
```

### Native Tests & Engine Regression

::: code-group
```sh [Rust Tests]
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

```sh [Headless Packaging Tests]
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features bundled-sqlite --test core_dragonfish_packaging_test
```

```sh [Linux Installer Tests]
python3 -m unittest discover -s deploy/playback-engine -p "test_*.py" -v
```
:::

## Build This Documentation Site Locally

```sh
npm --prefix website install
npm --prefix website run dev     # Live preview at http://localhost:5173/Cadence/
npm --prefix website run build   # Static production output under website/docs/.vitepress/dist/
```
