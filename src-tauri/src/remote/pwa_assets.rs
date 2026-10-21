pub const MANIFEST_JSON: &str = r##"{
  "name": "Cadence Remote",
  "short_name": "Cadence",
  "description": "Audiophile Grade Mobile Controller for Cadence Core",
  "start_url": "/?source=pwa",
  "display": "standalone",
  "background_color": "#09090b",
  "theme_color": "#09090b",
  "icons": [
    {
      "src": "/icon.svg",
      "sizes": "192x192 512x512",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ]
}"##;

pub const MOBILE_PWA_HTML: &str = r##"<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#09090b">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Cadence">
  <link rel="manifest" href="/manifest.json">
  <title>Cadence Remote | Audiophile Controller</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: #09090b;
      color: #f4f4f5;
      overflow: hidden;
      height: 100dvh;
      width: 100vw;
      user-select: none;
    }
    /* Safe-area insets for modern notch / dynamic island */
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100dvh;
      padding-top: env(safe-area-inset-top, 16px);
      padding-bottom: env(safe-area-inset-bottom, 16px);
      padding-left: env(safe-area-inset-left, 12px);
      padding-right: env(safe-area-inset-right, 12px);
      position: relative;
    }
    .ambient-backdrop {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background-size: cover;
      background-position: center;
      filter: blur(50px) brightness(0.22);
      transform: scale(1.15);
      z-index: 0;
      pointer-events: none;
      transition: background-image 0.8s ease-in-out;
    }
    .content-layer {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }
    /* Header */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      margin-bottom: 8px;
    }
    .brand-title {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .device-pill {
      font-size: 0.72rem;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
    }
    .dot-green { width: 6px; height: 6px; border-radius: 50%; background-color: #10b981; }
    /* Views */
    .view-panel { display: none; flex-direction: column; flex: 1; overflow-y: auto; padding-bottom: 64px; }
    .view-panel.active { display: flex; }
    /* Now Playing */
    .vinyl-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 8px 0;
    }
    .art-wrapper {
      width: min(72vw, 300px);
      height: min(72vw, 300px);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.12);
      position: relative;
      background: #18181b;
    }
    .art-img { width: 100%; height: 100%; object-fit: cover; }
    /* Telemetry badges */
    .badge-strip {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: center;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .audiophile-badge {
      font-size: 0.68rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-format { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-res { background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
    .badge-purity { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); display: none; }
    .badge-purity.active { display: inline-flex; align-items: center; gap: 4px; }
    /* Metadata */
    .meta-block {
      text-align: center;
      margin: 12px 16px 8px;
    }
    .track-title { font-size: 1.25rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .artist-name { font-size: 0.95rem; font-weight: 500; color: #a1a1aa; margin-top: 2px; }
    .album-name { font-size: 0.8rem; color: #71717a; margin-top: 2px; }
    /* Scrubber */
    .scrubber-block {
      padding: 0 16px;
      margin-bottom: 12px;
    }
    .time-strip {
      display: flex;
      justify-content: space-between;
      font-size: 0.72rem;
      color: #71717a;
      font-variant-numeric: tabular-nums;
      margin-top: 6px;
    }
    .progress-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      position: relative;
      cursor: pointer;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
      padding: 10px 0;
      margin: -10px 0;
      background-clip: content-box;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      border-radius: 3px;
      width: 0%;
      position: relative;
    }
    .progress-bar-fill::after {
      content: '';
      position: absolute;
      right: -6px; top: 7px;
      width: 12px; height: 12px;
      border-radius: 50%;
      background: #f4f4f5;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
    }
    /* Controls */
    .transport-bar {
      display: flex;
      align-items: center;
      justify-content: space-evenly;
      padding: 8px 12px;
      margin-bottom: 12px;
    }
    .btn-transport {
      background: transparent;
      border: none;
      color: #f4f4f5;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      border-radius: 50%;
      transition: transform 0.1s;
    }
    .btn-transport:active { transform: scale(0.92); }
    .btn-play-pause {
      width: 58px; height: 58px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
      box-shadow: 0 8px 24px -4px rgba(14, 165, 233, 0.45);
      color: #fff;
    }
    /* Volume */
    .volume-strip {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 24px;
      margin-bottom: 8px;
    }
    .vol-icon { color: #71717a; }
    .vol-slider {
      flex: 1;
      height: 5px;
      -webkit-appearance: none;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      outline: none;
    }
    .vol-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #e4e4e7;
      cursor: pointer;
    }
    .vol-slider:disabled { opacity: 0.4; }
    /* Bottom Nav Bar */
    .bottom-nav {
      position: absolute;
      bottom: env(safe-area-inset-bottom, 12px);
      left: 12px; right: 12px;
      height: 56px;
      background: rgba(24, 24, 27, 0.75);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 28px;
      display: flex;
      align-items: center;
      justify-content: space-around;
      z-index: 10;
    }
    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      color: #71717a;
      font-size: 0.65rem;
      cursor: pointer;
      padding: 6px 12px;
      border: none;
      background: transparent;
    }
    .nav-item.active { color: #38bdf8; font-weight: 600; }
    .nav-item svg { width: 20px; height: 20px; }
    /* Library / Queue List */
    .list-header { font-size: 1.1rem; font-weight: 700; margin: 12px 16px; }
    .queue-item, .track-row {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
    }
    .queue-item.active { background: rgba(56, 189, 248, 0.1); }
    .q-art { width: 44px; height: 44px; border-radius: 8px; margin-right: 12px; object-fit: cover; background: #27272a; }
    .q-info { flex: 1; overflow: hidden; }
    .q-title { font-size: 0.9rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .q-sub { font-size: 0.75rem; color: #71717a; margin-top: 2px; }
    /* Album Grid */
    .album-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      padding: 12px 16px;
    }
    .album-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
    }
    .album-card-art { width: 100%; aspect-ratio: 1; object-fit: cover; background: #27272a; }
    .album-card-meta { padding: 8px; }
    .album-card-title { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .album-card-sub { font-size: 0.72rem; color: #a1a1aa; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="ambient-backdrop" id="ambientBackdrop"></div>

  <div class="app-container">
    <div class="content-layer">
      <!-- Header -->
      <header class="top-bar">
        <div class="brand-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          CADENCE
        </div>
        <div class="device-pill" id="deviceBtn">
          <span class="dot-green"></span>
          <span id="deviceName">Default Output</span>
        </div>
      </header>

      <!-- View 1: Now Playing -->
      <section class="view-panel active" id="viewNowPlaying">
        <div class="vinyl-container">
          <div class="art-wrapper">
            <img id="nowPlayingArt" class="art-img" src="" alt="Album Artwork">
          </div>
          <div class="badge-strip">
            <span class="audiophile-badge badge-format" id="formatBadge">PCM</span>
            <span class="audiophile-badge badge-res" id="resBadge">44.1 kHz</span>
            <span class="audiophile-badge badge-purity" id="purityBadge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              BIT-PERFECT
            </span>
          </div>
        </div>

        <div class="meta-block">
          <div class="track-title" id="trackTitle">Cadence Core</div>
          <div class="artist-name" id="artistName">Select a track to play</div>
          <div class="album-name" id="albumName">Audiophile Transport</div>
        </div>

        <div class="scrubber-block">
          <div class="progress-bar-bg" id="scrubberTrack">
            <div class="progress-bar-fill" id="scrubberFill"></div>
          </div>
          <div class="time-strip">
            <span id="timeCurrent">0:00</span>
            <span id="timeDuration">0:00</span>
          </div>
        </div>

        <div class="transport-bar">
          <button class="btn-transport" id="btnPrev">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
          </button>
          <button class="btn-transport btn-play-pause" id="btnPlayPause">
            <svg id="playIcon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <svg id="pauseIcon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          </button>
          <button class="btn-transport" id="btnNext">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
          </button>
        </div>

        <div class="volume-strip">
          <svg class="vol-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          <input type="range" class="vol-slider" id="volSlider" min="0" max="1" step="0.01" value="1">
        </div>
      </section>

      <!-- View 2: Queue -->
      <section class="view-panel" id="viewQueue">
        <h2 class="list-header">Play Queue</h2>
        <div id="queueList"></div>
      </section>

      <!-- View 3: Library -->
      <section class="view-panel" id="viewLibrary">
        <h2 class="list-header">Releases</h2>
        <div class="album-grid" id="albumGrid"></div>
      </section>

      <!-- View 4: Audio Endpoints -->
      <section class="view-panel" id="viewDevices">
        <h2 class="list-header">Audio Endpoints</h2>
        <div id="deviceList" style="padding: 12px 16px;"></div>
      </section>
    </div>

    <!-- Bottom Navigation -->
    <nav class="bottom-nav">
      <button class="nav-item active" data-view="viewNowPlaying">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
        <span>Now Playing</span>
      </button>
      <button class="nav-item" data-view="viewQueue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        <span>Queue</span>
      </button>
      <button class="nav-item" data-view="viewLibrary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <span>Library</span>
      </button>
      <button class="nav-item" data-view="viewDevices">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span>Output</span>
      </button>
    </nav>
  </div>

  <script>
    // --- 1. Token & WebSocket Setup ---
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (tokenFromUrl) {
      localStorage.setItem('cadence_remote_token', tokenFromUrl);
    }
    let token = localStorage.getItem('cadence_remote_token') || '';
    if (!token) {
      const entered = prompt('Cadence Remote: Enter 4-digit pairing PIN shown on desktop:');
      if (entered) {
        token = entered.trim();
        localStorage.setItem('cadence_remote_token', token);
      }
    }

    function promptReauth() {
      const entered = prompt('Pairing PIN expired or invalid. Enter 4-digit PIN from Cadence Desktop:');
      if (entered) {
        token = entered.trim();
        localStorage.setItem('cadence_remote_token', token);
        window.location.reload();
      }
    }

    let ws = null;
    let syncPositionSecs = 0;
    let syncDurationSecs = 0;
    let syncTime = 0; // Recorded using performance.now() upon WebSocket packet arrival on mobile
    let syncIsPlaying = false;
    let syncRate = 1.0;
    let currentVolume = 1.0;
    let isPurityLocked = false;

    // Scrubber interaction state
    let isScrubbing = false;
    let scrubStartX = 0;
    let scrubStartY = 0;
    let scrubMoved = false;
    let pendingSeekSecs = 0;

    function formatTime(s) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    // --- 2. 120fps Client-Side Interpolation via requestAnimationFrame ---
    // Protected against client-server clock skew:
    // currentPos = basePos + (performance.now() - syncTime) * rate
    function updateScrubber() {
      if (!isScrubbing && syncIsPlaying && syncDurationSecs > 0) {
        const elapsedSecs = ((performance.now() - syncTime) / 1000) * syncRate;
        const current = Math.min(syncDurationSecs, Math.max(0, syncPositionSecs + elapsedSecs));
        const pct = (current / syncDurationSecs) * 100;
        document.getElementById('scrubberFill').style.width = `${pct}%`;
        document.getElementById('timeCurrent').textContent = formatTime(current);
      }
      requestAnimationFrame(updateScrubber);
    }
    requestAnimationFrame(updateScrubber);

    function connectWs() {
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${location.host}/api/remote/ws?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'STATE_CHANGE') {
            syncTime = performance.now();
            applyStateChange(msg);
          } else if (msg.type === 'HEARTBEAT') {
            syncPositionSecs = msg.positionSecs;
            syncDurationSecs = msg.durationSecs;
            syncTime = performance.now();
            syncIsPlaying = msg.isPlaying;
            syncRate = msg.rate || 1.0;
          } else if (msg.type === 'QUEUE_UPDATED') {
            renderQueue(msg.items, msg.currentIndex);
          }
        } catch (err) {
          console.error('[Cadence WS] Parse error:', err);
        }
      };

      ws.onclose = () => {
        setTimeout(connectWs, 3000);
      };
    }
    connectWs();

    function sendCommand(action, payload = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action, ...payload }));
      }
    }

    function applyStateChange(state) {
      syncIsPlaying = state.isPlaying && !state.isPaused;
      syncPositionSecs = state.positionSecs;
      syncDurationSecs = state.durationSecs;
      syncTime = performance.now();
      syncRate = 1.0;

      document.getElementById('playIcon').style.display = syncIsPlaying ? 'none' : 'block';
      document.getElementById('pauseIcon').style.display = syncIsPlaying ? 'block' : 'none';
      document.getElementById('timeDuration').textContent = formatTime(state.durationSecs);

      const sInfo = state.streamInfo;
      if (sInfo) {
        document.getElementById('trackTitle').textContent = sInfo.title || 'Unknown Title';
        document.getElementById('artistName').textContent = sInfo.artist || 'Unknown Artist';
        document.getElementById('albumName').textContent = sInfo.album || 'Unknown Album';
        document.getElementById('formatBadge').textContent = sInfo.format || 'AUDIO';
        
        const resText = sInfo.sampleRate ? `${(sInfo.sampleRate / 1000).toFixed(1)} kHz` : 'Hi-Res';
        document.getElementById('resBadge').textContent = resText;

        const artUrl = `/api/remote/library/artwork/${encodeURIComponent(sInfo.filePath)}?token=${encodeURIComponent(token)}`;
        document.getElementById('nowPlayingArt').src = artUrl;
        document.getElementById('ambientBackdrop').style.backgroundImage = `url('${artUrl}')`;
      }

      if (state.activeDevice) {
        document.getElementById('deviceName').textContent = state.activeDevice;
      }

      // Bit-Perfect Purity Lock
      isPurityLocked = Boolean(state.isPurityMode);
      const purityEl = document.getElementById('purityBadge');
      const volSlider = document.getElementById('volSlider');
      if (isPurityLocked) {
        purityEl.classList.add('active');
        volSlider.disabled = true;
        volSlider.value = 1.0;
      } else {
        purityEl.classList.remove('active');
        volSlider.disabled = false;
        volSlider.value = state.volume ?? 1.0;
      }
    }

    // --- 3. Event Listeners ---
    document.getElementById('btnPlayPause').addEventListener('click', () => {
      if (syncIsPlaying) {
        sendCommand('pause');
      } else {
        sendCommand('resume');
      }
    });

    document.getElementById('btnNext').addEventListener('click', () => sendCommand('next_track'));
    document.getElementById('btnPrev').addEventListener('click', () => sendCommand('prev_track'));

    document.getElementById('volSlider').addEventListener('input', (e) => {
      if (!isPurityLocked) {
        sendCommand('set_volume', { volume: parseFloat(e.target.value) });
      }
    });

    // --- 3B. Touch-Safe Pointer Scrubber (Scroll Protected & Commit on Release) ---
    const scrubberTrack = document.getElementById('scrubberTrack');

    function calculateSeekFromPointer(e) {
      const rect = scrubberTrack.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return { pct, seekSecs: pct * syncDurationSecs };
    }

    scrubberTrack.addEventListener('pointerdown', (e) => {
      isScrubbing = true;
      scrubStartX = e.clientX;
      scrubStartY = e.clientY;
      scrubMoved = false;
      try { scrubberTrack.setPointerCapture(e.pointerId); } catch (_) {}
      const { pct, seekSecs } = calculateSeekFromPointer(e);
      pendingSeekSecs = seekSecs;
      document.getElementById('scrubberFill').style.width = `${pct * 100}%`;
      document.getElementById('timeCurrent').textContent = formatTime(seekSecs);
    });

    scrubberTrack.addEventListener('pointermove', (e) => {
      if (!isScrubbing) return;
      const dx = Math.abs(e.clientX - scrubStartX);
      const dy = Math.abs(e.clientY - scrubStartY);

      // Scroll conflict protection: if user is scrolling vertically down page, cancel scrub
      if (!scrubMoved && dy > 12 && dy > dx) {
        isScrubbing = false;
        try { scrubberTrack.releasePointerCapture(e.pointerId); } catch (_) {}
        return;
      }

      scrubMoved = true;
      const { pct, seekSecs } = calculateSeekFromPointer(e);
      pendingSeekSecs = seekSecs;
      document.getElementById('scrubberFill').style.width = `${pct * 100}%`;
      document.getElementById('timeCurrent').textContent = formatTime(seekSecs);
      // NOTE: ZERO network commands are dispatched during drag. Transport & UPnP stream remain completely undisturbed.
    });

    function commitScrub(e) {
      if (!isScrubbing) return;
      isScrubbing = false;
      try { scrubberTrack.releasePointerCapture(e.pointerId); } catch (_) {}
      syncPositionSecs = pendingSeekSecs;
      syncTime = performance.now();
      // Commit seek ONCE on release
      sendCommand('seek', { position_secs: pendingSeekSecs });
    }

    scrubberTrack.addEventListener('pointerup', commitScrub);
    scrubberTrack.addEventListener('pointercancel', (e) => {
      isScrubbing = false;
      try { scrubberTrack.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    // --- 4. Navigation ---
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const viewId = btn.getAttribute('data-view');
        document.getElementById(viewId).classList.add('active');
        if (viewId === 'viewLibrary') loadLibrary();
        if (viewId === 'viewDevices') loadDevices();
      });
    });

    // --- 5. Library & Queue Loading ---
    async function loadLibrary() {
      try {
        const res = await fetch(`/api/remote/library/releases?token=${encodeURIComponent(token)}`);
        if (res.status === 401) { promptReauth(); return; }
        const releases = await res.json();
        const grid = document.getElementById('albumGrid');
        grid.innerHTML = releases.map((r) => `
          <div class="album-card" onclick="playRelease('${r.id}')">
            <img class="album-card-art" src="/api/remote/library/artwork/${encodeURIComponent(r.id)}?token=${encodeURIComponent(token)}" loading="lazy">
            <div class="album-card-meta">
              <div class="album-card-title">${r.title}</div>
              <div class="album-card-sub">${r.artistCredit}</div>
            </div>
          </div>
        `).join('');
      } catch (e) {
        console.error('Error loading library:', e);
      }
    }

    async function loadDevices() {
      try {
        const res = await fetch(`/api/remote/devices?token=${encodeURIComponent(token)}`);
        if (res.status === 401) { promptReauth(); return; }
        const devices = await res.json();
        const list = document.getElementById('deviceList');
        list.innerHTML = devices.map((d) => `
          <div class="track-row" onclick="selectDevice('${d}')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:12px;"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span style="font-weight:600; font-size:0.9rem;">${d}</span>
          </div>
        `).join('');
      } catch (e) {
        console.error('Error loading devices:', e);
      }
    }

    function renderQueue(items, currentIdx) {
      const list = document.getElementById('queueList');
      if (!items || items.length === 0) {
        list.innerHTML = '<div style="padding:24px; text-align:center; color:#71717a;">Queue is empty</div>';
        return;
      }
      list.innerHTML = items.map((t, idx) => `
        <div class="queue-item ${idx === currentIdx ? 'active' : ''}" onclick="jumpQueue(${idx})">
          <img class="q-art" src="/api/remote/library/artwork/${encodeURIComponent(t.id)}?token=${encodeURIComponent(token)}" loading="lazy">
          <div class="q-info">
            <div class="q-title">${t.title}</div>
            <div class="q-sub">${t.artist} &bull; ${formatTime(t.durationSecs)}</div>
          </div>
        </div>
      `).join('');
    }

    window.jumpQueue = (idx) => sendCommand('jump_to_queue_index', { index: idx });
    window.playRelease = (releaseId) => sendCommand('play_release', { release_id: releaseId });
    window.selectDevice = async (name) => {
      await fetch('/api/remote/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: name, token })
      });
      document.getElementById('deviceName').textContent = name;
    };

    // --- 6. Mobile Screen-Wake & Tab-Visibility Resync (visibilitychange + focus) ---
    async function resyncStatus() {
      try {
        if (!token) return;
        const res = await fetch(`/api/remote/status?token=${encodeURIComponent(token)}`);
        if (res.status === 401) { promptReauth(); return; }
        if (res.ok) {
          const status = await res.json();
          syncTime = performance.now();
          applyStateChange(status);
        }
      } catch (err) {
        console.warn('[Cadence Remote] Resync status error:', err);
      }
    }

    function handleVisibilityOrFocus() {
      if (document.visibilityState === 'visible') {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connectWs();
        }
        resyncStatus();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
  </script>
</body>
</html>
"##;
