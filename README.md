# Cadence Core - Relational Audiophile Engine

Cadence Core is a high-performance, relational audiophile music manager and playback engine built with **React 19**, **TypeScript**, **Tailwind CSS v4**, and **Tauri v2** (Rust audio engine & SQLite database).

---

## 🚀 How to Start the App

### 1. Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: v18+ (v20+ recommended)
- **npm** (or pnpm / yarn)
- **Rust & Cargo** *(required for desktop mode)*: Install via [rustup.rs](https://rustup.rs) (`rustc --version` and `cargo --version`)

### 2. Initial Setup

1. **Clone the repository and install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   *(On Windows PowerShell: `Copy-Item .env.example .env`)*

   Add your Google Gemini API key if you plan to use AI metadata enrichment, cover art fetching, and the Cadence Agent:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

---

### 3. Starting the Application

You can run Cadence Core in two modes:

#### Option A: Desktop App (Recommended for Audiophile Playback)
Runs the full native desktop application with bit-perfect Rust audio output, local SQLite database storage, native folder selection, and direct disk scanning.

```bash
npm run tauri:dev
```

#### Option B: Web Browser Dev Mode
Runs the frontend in your web browser via the Vite dev server with HTML5 Web Audio fallback and Vite-based mock/local scanning endpoints.

```bash
npm run dev
```
Then open your browser to **`http://localhost:5173`**.

---

## 📦 Building for Production

- **Desktop Application (Native installer / executable)**:
  ```bash
  npm run tauri:build
  ```
  The compiled installer will be located in `src-tauri/target/release/bundle/`.

- **Web Frontend Static Bundle**:
  ```bash
  npm run build
  ```
  The production build will be emitted to `dist/`. You can preview it with:
  ```bash
  npm run preview
  ```

---

## 🛠️ Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run tauri:dev` | Launch Cadence Core in native desktop mode (Tauri v2 + Vite) |
| `npm run dev` | Start the local Vite development server (`http://localhost:5173`) |
| `npm run tauri:build` | Build the native desktop release bundle (.exe / installer) |
| `npm run build` | Typecheck (`tsc -b`) and build the web bundle with Vite |
| `npm run preview` | Locally preview the built web application |
| `npm run lint` | Fast linting using [oxlint](https://oxc.rs) |
| `npm run test:norm` | Run normalization & enrichment precedence tests |
| `npm run test:engine` | Verify the relational graph engine |
| `npm run test:pilot` | Run Cadence Copilot matrix tests |

---

## 🧩 Architecture

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons
- **Desktop Runtime**: Tauri v2, Rust
- **Audio Engine**: Native bit-perfect multi-format stream decoder (FLAC, DSF/DFF, ALAC, WAV, MP3, etc.)
- **Database**: Embedded SQLite for persistent relational metadata & storage mounts
- **AI & Enrichment**: Gemini API integration for artist taxonomy, fuzzy title resolution, and artwork enrichment
- **Tagging & Sidecars**: Non-destructive 2-phase commit sidecar metadata system (`cadence-album.sidecar.json`)
