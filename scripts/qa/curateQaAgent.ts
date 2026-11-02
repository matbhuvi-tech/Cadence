/**
 * scripts/qa/curateQaAgent.ts
 * External Multimodal Quality Testing Agent for Cadence Curate Cockpit.
 * 
 * Features & Invariants:
 * 1. Standard DOM & data-testid selectors (no invalid jQuery :contains() pseudo-selectors).
 * 2. Pre-Staging Oracle Verification: asserts canonical metadata & tracks BEFORE clicking "Stage & Next".
 * 3. Multimodal Decision Engine: calls Gemini 2.5 Flash Vision when GEMINI_API_KEY is available,
 *    or executes the full deterministic P1 -> P4 Priority Gate & Consensus Audit rule engine.
 * 4. Loop Prevention & Click Verification: checks clickSelector() return values, logs UI Interaction
 *    Bugs on failure, and tracks visitedActions per identity_epoch to prevent infinite loops.
 * 5. React Controlled Input Support: uses prototype value setter + dispatchEvent for flawless clearing.
 * 6. Zero production binary bloat: runs externally over CDP on port 9222.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

// --- Types ---
export interface TrackOracle {
  track_number: number;
  title: string;
  artists: string[];
  primary_artists?: string[];
  composer?: string;
  duration_seconds: number;
  expected_file_pattern: string;
}

export interface AlbumOracleManifest {
  album_id: string;
  album_type: 'soundtrack' | 'compilation' | 'studio';
  canonical_title: string;
  canonical_artist: string;
  canonical_composer?: string;
  release_year: number;
  genre: string;
  expected_track_count: number;
  sequence_offset?: number;
  tracks: TrackOracle[];
}

export interface CurateOracleDatabase {
  version: string;
  albums: Record<string, AlbumOracleManifest>;
}

export type BugClassification =
  | 'Identity Resolution Bug'
  | 'Provider Retrieval Bug'
  | 'Consensus/Selection Bug'
  | 'Steering Bug'
  | 'Reconciliation Bug'
  | 'UI Interaction Bug'
  | 'Lifecycle Bug'
  | 'Test Oracle Gap';

export interface BugRecord {
  classification: BugClassification;
  severity: 'BLOCKER' | 'MAJOR' | 'MINOR';
  albumId: string;
  stepNumber: number;
  description: string;
  expected: string;
  actual: string;
  screenshotPath?: string;
}

export interface AgentAction {
  action: 'CLICK' | 'STEER' | 'EDIT' | 'STAGE' | 'WAIT';
  targetSelector?: string;
  targetDescription: string;
  value?: string;
  artistValue?: string;
  priorityLevel: 'P1' | 'P2' | 'P3' | 'P4';
  reasoning: string;
  detectedBugs?: BugRecord[];
}

// --- CDP Client ---
export class CdpSession {
  private ws!: WebSocket;
  private idCounter = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  static async connect(port = 9222): Promise<CdpSession> {
    let listRes;
    try {
      listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    } catch (err: any) {
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
        console.error(`\n❌ Could not connect to Cadence CDP endpoint on port ${port} (ECONNREFUSED).`);
        console.error(`💡 Cadence is not currently running with remote debugging enabled.`);
        console.error(`👉 Please launch Cadence first in a separate terminal using:`);
        console.error(`     .\\scripts\\launch-debug-cadence.ps1\n`);
      }
      throw err;
    }
    const targets = (await listRes.json()) as any[];
    const pageTarget = targets.find((t) => t.type === 'page' || t.title.includes('Cadence'));

    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error(`No active WebView2 page target found on port ${port}. Targets found: ${JSON.stringify(targets)}`);
    }

    const session = new CdpSession();
    await session.init(pageTarget.webSocketDebuggerUrl);
    return session;
  }

  private init(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        try {
          await this.send('Page.enable');
          await this.send('DOM.enable');
          await this.send('Runtime.enable');
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      this.ws.onerror = (err) => reject(err);

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      };
    });
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.idCounter++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`CDP Evaluate Error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async captureScreenshot(outputPath?: string): Promise<string> {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const b64 = res.data as string;
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
    }
    return b64;
  }

  async clickSelector(selector: string): Promise<boolean> {
    const box = await this.evaluate(`
      (() => {
        let el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 };
      })()
    `);

    if (!box || !box.visible) return false;

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    return true;
  }

  async typeIntoSelector(selector: string, text: string): Promise<boolean> {
    const focused = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        // React controlled input clearing
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    if (!focused) return false;

    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    }

    await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    return true;
  }

  close() {
    this.ws.close();
  }
}

// --- Main QA Agent Harness ---
function matchesSingerAlias(targetText: string, oracleSinger: string): boolean {
  if (!targetText) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[\.\s\-_,]+/g, ' ').trim();
  const tNorm = norm(targetText);
  const sNorm = norm(oracleSinger);

  if (tNorm.includes(sNorm)) return true;

  // Common aliases mapping in Indian cinema discography
  const aliases: Record<string, string[]> = {
    's. p. balasubrahmanyam': ['spb', 's p b', 'balasubrahmanyam', 'balasubramaniam', 's.p.b', 's. p. b.'],
    'k. s. chithra': ['chithra', 'chitra', 'k s chitra', 'k.s. chitra', 'k. s. chitra'],
    'k. j. yesudas': ['yesudas', 'k j yesudas', 'k.j. yesudas', 'k. j. yesudas'],
    's. janaki': ['janaki', 's janaki', 's. janaki'],
    'p. susheela': ['susheela', 'p susheela', 'p. susheela'],
    'malaysia vasudevan': ['vasudevan', 'malaysia vasudevan'],
    'ilaiyaraaja': ['ilayaraja', 'illayaraja', 'raaja', 'ilaiyaraaja'],
    'a. r. rahman': ['ar rahman', 'a r rahman', 'rahman', 'a.r. rahman'],
  };

  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (sNorm.includes(canonical) || aliasList.some((a) => norm(a) === sNorm)) {
      if (aliasList.some((a) => tNorm.includes(norm(a))) || tNorm.includes(canonical)) {
        return true;
      }
    }
  }

  // Token boundary check: if any significant word (>=4 chars) matches
  const tokens = sNorm.split(' ').filter((w) => w.length >= 4);
  return tokens.some((tok) => tNorm.includes(tok));
}

export class CurateMultimodalQaAgent {
  private cdp!: CdpSession;
  private oracleDb: CurateOracleDatabase;
  private bugs: BugRecord[] = [];
  private recordedBugKeys = new Set<string>();
  private stepTrace: Array<{ step: number; action: string; reasoning: string; screenshot: string }> = [];
  private identityEpoch = 0;
  private visitedActions = new Set<string>();
  private reportsDir = path.resolve(process.cwd(), 'reports');
  private screenshotsDir = path.resolve(process.cwd(), 'reports', 'screenshots');

  constructor() {
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    const oraclePath = path.resolve(process.cwd(), 'tests', 'fixtures', 'curate', 'oracle.json');
    if (fs.existsSync(oraclePath)) {
      this.oracleDb = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
    } else {
      this.oracleDb = { version: '1.0.0', albums: {} };
    }
  }

  async run(targetAlbumQuery?: string) {
    console.log('🤖 [Curate QA Agent] Initializing External Multimodal Testing Harness...');
    this.cdp = await CdpSession.connect(9222);

    try {
      await this.navigateToCurateCockpit();

      const sidebarAlbums = await this.extractSidebarAlbums();
      console.log(`📋 Found ${sidebarAlbums.length} albums pending review in sidebar.`);

      const testTargets = targetAlbumQuery
        ? sidebarAlbums.filter((a) => a.title.toLowerCase().includes(targetAlbumQuery.toLowerCase()))
        : sidebarAlbums.slice(0, 3);

      if (testTargets.length === 0) {
        console.log(`⚠️ No albums matching query "${targetAlbumQuery || 'all'}" found in Curate queue.`);
        return;
      }

      for (const target of testTargets) {
        console.log(`\n🎵 ==========================================`);
        console.log(`🎯 Testing Album Curation Journey: "${target.title}"`);
        console.log(`==========================================`);
        await this.curateAlbumJourney(target.id, target.title);
      }

      this.generateDefectReport();
    } finally {
      this.cdp.close();
    }
  }

  private async navigateToCurateCockpit() {
    const isCockpit = await this.cdp.evaluate(`
      Boolean(document.querySelector('h1')?.textContent?.includes('Curate') || document.querySelector('input[placeholder*="Steer"]') || document.querySelector('[data-testid="btn-stage-next"]'))
    `);

    if (!isCockpit) {
      console.log('🔄 Navigating to Curate Cockpit (keyboard shortcut ⌘2 / Alt+2 or nav item)...');
      await this.cdp.evaluate(`
        (() => {
          const curateBtn = Array.from(document.querySelectorAll('button, a')).find(el => el.textContent.includes('Curate'));
          if (curateBtn) curateBtn.click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async extractSidebarAlbums(): Promise<Array<{ id: string; title: string; tracks: number }>> {
    let albums = await this.cdp.evaluate(`
      (() => {
        const items = document.querySelectorAll('div[data-testid="curate-album-item"], div.cursor-pointer:has(h3)');
        return Array.from(items).map(item => ({
          id: item.getAttribute('data-album-id') || item.textContent.trim().split('\\n')[0],
          title: item.querySelector('h3, span[class*="font-semibold"], div[class*="font-medium"]')?.textContent?.trim() || item.textContent.trim().split('\\n')[0],
          tracks: parseInt(item.textContent?.match(/(\\d+)\\s*tracks/i)?.[1] || '0', 10)
        })).filter(a => a.title && !a.title.includes('Tier ') && !a.title.includes('No albums'));
      })()
    `);

    if (albums.length === 0) {
      console.log('🔄 Current tier tab has 0 albums. Switching to Tier 2 Guided Reconciliation tab...');
      await this.cdp.evaluate(`
        (() => {
          const tier2Btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tier 2'));
          if (tier2Btn) tier2Btn.click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 1200));

      albums = await this.cdp.evaluate(`
        (() => {
          const items = document.querySelectorAll('div[data-testid="curate-album-item"], div.cursor-pointer:has(h3)');
          return Array.from(items).map(item => ({
            id: item.getAttribute('data-album-id') || item.textContent.trim().split('\\n')[0],
            title: item.querySelector('h3, span[class*="font-semibold"], div[class*="font-medium"]')?.textContent?.trim() || item.textContent.trim().split('\\n')[0],
            tracks: parseInt(item.textContent?.match(/(\\d+)\\s*tracks/i)?.[1] || '0', 10)
          })).filter(a => a.title && !a.title.includes('Tier ') && !a.title.includes('No albums'));
        })()
      `);
    }

    return albums;
  }

  private async curateAlbumJourney(albumId: string, initialTitle: string) {
    let turn = 1;
    const maxTurns = 12;
    let isStaged = false;
    this.identityEpoch = 0;
    this.visitedActions.clear();

    // 0. CHECK ORACLE GROUND TRUTH FIRST
    let oracle = this.findMatchingOracle(initialTitle);
    if (!oracle) {
      oracle = await this.promptUserForOracleGrounding(initialTitle);
    }

    // Select album in sidebar
    await this.cdp.evaluate(`
      (() => {
        const item = Array.from(document.querySelectorAll('div[data-testid="curate-album-item"], div.cursor-pointer')).find(el => el.textContent.includes(${JSON.stringify(initialTitle)}));
        if (item) item.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 1200));

    while (turn <= maxTurns && !isStaged) {
      console.log(`\n--- [Turn ${turn}/${maxTurns}] Evaluating Curation Cockpit State ---`);

      // 1. OBSERVE: Capture Screenshot & Pruned DOM
      const screenshotFilename = `step-${Date.now()}-${turn}.png`;
      const screenshotPath = path.join(this.screenshotsDir, screenshotFilename);
      const screenshotBase64 = await this.cdp.captureScreenshot(screenshotPath);

      const domSnapshot = await this.extractCockpitState();

      // 2. CLASSIFY & ACT: Human-mimicking P1 -> P4 Decision Turn
      const action = await this.decideNextAction(domSnapshot, screenshotBase64, turn);
      console.log(`💡 [Decision]: ${action.priorityLevel} - ${action.targetDescription}`);
      console.log(`   Reasoning: ${action.reasoning}`);

      // Record any bugs identified during decision phase
      if (action.detectedBugs && action.detectedBugs.length > 0) {
        for (const b of action.detectedBugs) {
          b.albumId = albumId;
          b.stepNumber = turn;
          b.screenshotPath = screenshotPath;
          this.recordBug(b);
        }
      }

      this.stepTrace.push({
        step: turn,
        action: `${action.priorityLevel}: ${action.targetDescription}`,
        reasoning: action.reasoning,
        screenshot: screenshotFilename,
      });

      // 3. PREVENT INFINITE LOOPS
      const actionKey = `${action.priorityLevel}:${action.action}:${action.targetSelector || action.value || action.targetDescription}`;
      if (this.visitedActions.has(actionKey) && action.action !== 'STAGE') {
        console.log(`⚠️ Infinite action loop detected on ${actionKey}; Cadence UI failed to mutate state after previous interaction.`);
        this.recordBug({
          classification: 'UI Interaction Bug',
          severity: 'BLOCKER',
          albumId,
          stepNumber: turn,
          description: `Infinite action loop detected on ${actionKey}; Cadence UI failed to mutate state after previous interaction.`,
          expected: 'UI state mutation upon interaction',
          actual: 'State remained unchanged, causing cycle',
          screenshotPath,
        });
        break;
      }
      this.visitedActions.add(actionKey);

      // 4. EXECUTE ACTION
      if (action.action === 'STAGE') {
        // MANDATORY AUDIT: Verify against Oracle BEFORE clicking "Stage & Next"!
        console.log(`🔍 [Pre-Stage Gate] Running Oracle & Invariant Verification BEFORE clicking Stage...`);
        await this.verifyReleaseAgainstOracle(albumId, initialTitle, screenshotPath, oracle);

        const clicked = await this.cdp.clickSelector('[data-testid="btn-stage-next"]');
        if (clicked) {
          console.log('✅ Successfully clicked "Stage & Next"!');
          isStaged = true;
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          this.recordBug({
            classification: 'UI Interaction Bug',
            severity: 'BLOCKER',
            albumId,
            stepNumber: turn,
            description: 'Could not find or click [data-testid="btn-stage-next"] button',
            expected: 'Clickable Stage & Next button',
            actual: 'Button missing or unclickable',
            screenshotPath,
          });
        }
        break;
      } else if (action.action === 'STEER') {
        this.identityEpoch++;
        this.visitedActions.clear();
        console.log(`🎯 Executing Steer Providers with query: "${action.value}"`);
        const typed = await this.cdp.typeIntoSelector('input[data-testid="input-steer-album"], input[placeholder*="Steer"]', action.value || '');
        if (!typed) {
          this.recordBug({
            classification: 'UI Interaction Bug',
            severity: 'MAJOR',
            albumId,
            stepNumber: turn,
            description: 'Failed to type query into Steer Providers input',
            expected: 'Focusable input for steering',
            actual: 'Input missing or non-editable',
            screenshotPath,
          });
        }
        const fetchClicked = await this.cdp.clickSelector('[data-testid="btn-fetch-anchor"]');
        if (!fetchClicked) {
          this.recordBug({
            classification: 'UI Interaction Bug',
            severity: 'MAJOR',
            albumId,
            stepNumber: turn,
            description: 'Failed to click Fetch & Anchor button',
            expected: 'Clickable Fetch & Anchor button',
            actual: 'Button missing or disabled',
            screenshotPath,
          });
        }
        console.log(`⏳ Awaiting provider fetch & anchor for epoch ${this.identityEpoch}...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else if (action.action === 'EDIT' && action.targetSelector && action.value) {
        console.log(`?? Executing Manual Edit on ${action.targetSelector} with value: "${action.value}"`);
        await this.cdp.clickSelector(action.targetSelector);
        await new Promise((r) => setTimeout(r, 400));
        await this.cdp.typeIntoSelector('td input[type="text"], input[type="text"]:focus', action.value);
        await this.cdp.clickSelector('button[title="Save"], td button.bg-emerald-500');
        await new Promise((r) => setTimeout(r, 600));
      } else if (action.action === 'CLICK' && action.targetSelector) {
        const ok = await this.cdp.clickSelector(action.targetSelector);
        if (!ok) {
          this.recordBug({
            classification: 'UI Interaction Bug',
            severity: 'MAJOR',
            albumId,
            stepNumber: turn,
            description: `clickSelector failed on target: ${action.targetSelector}`,
            expected: `Clickable element at ${action.targetSelector}`,
            actual: 'Element not found or not visible',
            screenshotPath,
          });
        }
        await new Promise((r) => setTimeout(r, 800));
      }

      turn++;
    }
  }

  private findMatchingOracle(initialTitle: string): AlbumOracleManifest | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const initialNorm = norm(initialTitle);
    const matchedKey = Object.keys(this.oracleDb.albums).find((k) => {
      const cand = this.oracleDb.albums[k];
      const kNorm = norm(k);
      const titleNorm = norm(cand.canonical_title || '');
      return (
        initialNorm.includes(kNorm) ||
        kNorm.includes(initialNorm) ||
        initialNorm.includes(titleNorm) ||
        titleNorm.includes(initialNorm)
      );
    });
    return matchedKey ? this.oracleDb.albums[matchedKey] : null;
  }

  private async promptUserForOracleGrounding(initialTitle: string): Promise<AlbumOracleManifest | null> {
    console.log('\n======================================================');
    console.log(`⚠️  [Oracle Missing] No entry found in oracle.json for: "${initialTitle}"`);
    console.log('======================================================');
    console.log('Provide a reference URL to construct the ground-truth fixture:');
    console.log('  - Wikipedia: e.g. https://en.wikipedia.org/wiki/...');
    console.log('  - Apple Music: e.g. https://music.apple.com/in/album/...');
    console.log('  - Or press ENTER to skip ground-truth assertions for this album.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let inputUrl = '';
    try {
      inputUrl = (await rl.question('\n🔗 Reference URL: ')).trim();
    } finally {
      rl.close();
    }

    if (!inputUrl) {
      console.log(`ℹ️ No URL provided. Skipping ground truth construction for "${initialTitle}".`);
      return null;
    }

    console.log(`\n⏳ Fetching reference data from: ${inputUrl}...`);
    let manifest: AlbumOracleManifest | null = null;

    if (inputUrl.includes('music.apple.com') || inputUrl.includes('itunes.apple.com')) {
      manifest = await this.constructOracleFromAppleMusic(inputUrl, initialTitle);
    } else if (inputUrl.includes('wikipedia.org')) {
      manifest = await this.constructOracleFromWikipedia(inputUrl, initialTitle);
    } else {
      console.log('⚠️ Unrecognized URL domain. Expected Wikipedia or Apple Music.');
      return null;
    }

    if (!manifest) {
      console.log('❌ Failed to extract metadata from the provided URL.');
      return null;
    }

    // Save to tests/fixtures/curate/oracle.json
    const oraclePath = path.resolve(process.cwd(), 'tests', 'fixtures', 'curate', 'oracle.json');
    const slug = (manifest.canonical_title || initialTitle)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    manifest.album_id = slug;
    this.oracleDb.albums[slug] = manifest;
    fs.writeFileSync(oraclePath, JSON.stringify(this.oracleDb, null, 2), 'utf8');

    console.log('\n======================================================');
    console.log(`✅ Constructed Oracle fixture for "${manifest.canonical_title}"!`);
    console.log(`💾 Saved to: ${oraclePath}`);
    console.log('======================================================');
    console.log('👉 Please inspect and validate the updates in oracle.json in your editor.');

    const rlConfirm = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rlConfirm.question(`Press ENTER to confirm you have validated oracle.json (or type 'cancel' to skip): `);
      if (answer.trim().toLowerCase() === 'cancel') {
        console.log('🚫 Oracle validation cancelled by user. Skipping release.');
        return null;
      }
    } finally {
      rlConfirm.close();
    }

    // Reload from disk to capture any manual edits made by the user
    this.oracleDb = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
    const reloaded = this.oracleDb.albums[slug] || manifest;
    console.log('✨ Oracle validated and reloaded from disk. Proceeding with testing!');
    return reloaded;
  }

  private async constructOracleFromAppleMusic(url: string, fallbackTitle: string): Promise<AlbumOracleManifest | null> {
    try {
      const match = url.match(/\/album\/(?:[^\/]+\/)?(\d+)/i) || url.match(/id=(\d+)/i) || url.match(/(\d{8,12})/);
      if (!match) {
        console.error('❌ Could not parse Apple Music album ID from URL.');
        return null;
      }
      const albumId = match[1];
      const countryMatch = url.match(/music\.apple\.com\/([a-z]{2})\//i);
      const country = countryMatch ? countryMatch[1] : 'in';

      const res = await fetch(`https://itunes.apple.com/lookup?id=${albumId}&entity=song&country=${country}`);
      if (!res.ok) throw new Error(`iTunes API HTTP ${res.status}`);
      const data = (await res.json()) as any;
      const results = data.results || [];
      if (results.length === 0) return null;

      const coll = results[0];
      const songs = results.slice(1);

      const cleanTitle = (coll.collectionName || fallbackTitle)
        .replace(/\s*-\s*(single|ep|original motion picture soundtrack|soundtrack)\b/gi, '')
        .trim();

      const year = coll.releaseDate ? parseInt(coll.releaseDate.slice(0, 4), 10) : new Date().getFullYear();

      const manifest: AlbumOracleManifest = {
        album_id: cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        album_type: 'soundtrack',
        canonical_title: cleanTitle,
        canonical_artist: coll.artistName || 'Various Artists',
        canonical_composer: coll.artistName || '',
        release_year: year,
        genre: coll.primaryGenreName || 'Soundtrack',
        expected_track_count: songs.length,
        tracks: songs.map((s: any, idx: number) => ({
          track_number: s.trackNumber || idx + 1,
          title: (s.trackName || `Track ${idx + 1}`).trim(),
          artists: [s.artistName || coll.artistName || ''],
          composer: coll.artistName || '',
          duration_seconds: Math.round((s.trackTimeMillis || 0) / 1000),
          expected_file_pattern: `.*(${s.trackName ? s.trackName.toLowerCase().replace(/[^a-z0-9]+/g, '.*') : '.*'}).*`,
        })),
      };

      return manifest;
    } catch (err) {
      console.error('❌ Failed to construct Oracle from Apple Music:', err);
      return null;
    }
  }

  private async constructOracleFromWikipedia(url: string, fallbackTitle: string): Promise<AlbumOracleManifest | null> {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Cadence-QA-Agent/1.0 (contact: info@cadence.local)' } });
      if (!res.ok) throw new Error(`Wikipedia fetch HTTP ${res.status}`);
      const html = await res.text();

      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        console.log('🤖 Using Gemini to extract structured ground-truth manifest from Wikipedia...');
        const textContent = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 50000);

        const prompt = `You are an archival music librarian creating a ground-truth test manifest from this Wikipedia article.
Target Album: "${fallbackTitle}"
Article text:
${textContent}

Extract and return ONLY a valid JSON object matching this exact structure:
{
  "album_type": "soundtrack",
  "canonical_title": "<official movie/album title without rip tags>",
  "canonical_artist": "<primary music director/artist e.g. Ilaiyaraaja, A. R. Rahman>",
  "canonical_composer": "<music director/composer>",
  "release_year": 1985,
  "genre": "Tamil Film Soundtrack",
  "expected_track_count": 5,
  "tracks": [
    {
      "track_number": 1,
      "title": "<clean song title>",
      "artists": ["<Playback Singer 1>", "<Playback Singer 2>"],
      "composer": "<composer>",
      "duration_seconds": 270,
      "expected_file_pattern": ".*(keyword).*"
    }
  ]
}
RULES:
- tracks[i].artists MUST be the authentic Playback Singers from the Track Listing table.
- NEVER copy the composer into track artists unless the composer personally sang on that track.
No markdown backticks, just the JSON.`;

        const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (gemRes.ok) {
          const gemData = await gemRes.json();
          const jsonText = gemData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (jsonText) {
            const parsed = JSON.parse(jsonText);
            parsed.album_id = (parsed.canonical_title || fallbackTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-');
            return parsed as AlbumOracleManifest;
          }
        }
      }

      // Fallback HTML table parser if no Gemini API key
      console.log('ℹ️ Parsing Wikipedia HTML soundtrack section...');
      const soundtrackMatch =
        html.match(/id="Soundtrack"[\s\S]*?(<table[\s\S]*?<\/table>)/i) ||
        html.match(/id="Track_listing"[\s\S]*?(<table[\s\S]*?<\/table>)/i);

      const tracks: TrackOracle[] = [];
      if (soundtrackMatch) {
        const tableHtml = soundtrackMatch[1];
        const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        let tNum = 1;
        for (const row of rowMatches) {
          const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/<[^>]+>/g, '').trim());
          if (cells.length >= 2 && !cells[0].toLowerCase().includes('no') && !cells[0].toLowerCase().includes('#')) {
            const title = cells[1] ? cells[1].replace(/"/g, '') : `Track ${tNum}`;
            const singerStr = cells[2] || '';
            const singers = singerStr.split(/[,&]/).map((s) => s.trim()).filter(Boolean);
            tracks.push({
              track_number: tNum,
              title,
              artists: singers.length > 0 ? singers : ['Unknown'],
              duration_seconds: 270,
              expected_file_pattern: `.*(${title.toLowerCase().split(' ')[0] || '.*'}).*`,
            });
            tNum++;
          }
        }
      }

      const cleanTitle = fallbackTitle.replace(/\s*cd\s*rip/gi, '').trim();
      return {
        album_id: cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        album_type: 'soundtrack',
        canonical_title: cleanTitle,
        canonical_artist: 'Various Artists',
        canonical_composer: '',
        release_year: 1985,
        genre: 'Tamil Film Soundtrack',
        expected_track_count: tracks.length || 5,
        tracks:
          tracks.length > 0
            ? tracks
            : [{ track_number: 1, title: 'Sample Track', artists: ['Sample Singer'], duration_seconds: 270, expected_file_pattern: '.*' }],
      };
    } catch (err) {
      console.error('❌ Failed to construct Oracle from Wikipedia:', err);
      return null;
    }
  }

  private async extractCockpitState() {
    return await this.cdp.evaluate(`
      (() => {
        const getMasterRow = (fieldKey) => {
          const row = document.querySelector(\`[data-testid="master-row-\${fieldKey}"]\`);
          if (!row) return null;
          const getVal = (col) => row.querySelector(\`[data-testid="master-cell-\${fieldKey}-\${col}"]\`)?.textContent?.trim() || '';
          return {
            field: fieldKey,
            local: getVal('local'),
            apple: getVal('apple'),
            musicbrainz: getVal('musicbrainz'),
            ai: getVal('ai'),
            selected: getVal('selected')
          };
        };

        const getTrackRows = () => {
          const rows = document.querySelectorAll('tr[data-testid^="track-row-"]');
          return Array.from(rows).map((row, idx) => {
            const getCell = (col) => {
              const cell = row.querySelector('[data-testid="track-cell-' + idx + '-' + col + '"]');
              if (!cell) return { text: '', title: '', artist: '' };
              const titleEl = cell.querySelector('.font-medium');
              const artistEl = cell.querySelector('[class*="text-[10px]"], [class*="text-[11px]"]');
              const title = titleEl ? titleEl.textContent.trim() : '';
              let artist = artistEl ? artistEl.textContent.trim() : '';
              if (artist.startsWith('??') || artist.includes('Requires Action')) {
                artist = '';
              }
              const text = (title && artist && artist !== '?' && artist !== '-')
                ? (title + ' // ' + artist)
                : (title || artist || cell.textContent.trim());
              return { text, title, artist };
            };

            const localCell = getCell('local');
            const appleCell = getCell('apple');
            const mbCell = getCell('musicbrainz');
            const aiCell = getCell('ai');
            const selectedCell = getCell('selected');

            return {
              index: idx,
              local: localCell.text,
              localTitle: localCell.title,
              localArtist: localCell.artist,
              apple: appleCell.text,
              appleTitle: appleCell.title,
              appleArtist: appleCell.artist,
              musicbrainz: mbCell.text,
              musicbrainzTitle: mbCell.title,
              musicbrainzArtist: mbCell.artist,
              ai: aiCell.text,
              aiTitle: aiCell.title,
              aiArtist: aiCell.artist,
              selected: selectedCell.text,
              selectedTitle: selectedCell.title,
              selectedArtist: selectedCell.artist
            };
          });
        };

        return {
          master: {
            title: getMasterRow('albumTitle'),
            artist: getMasterRow('albumArtist'),
            composer: getMasterRow('composer'),
            year: getMasterRow('year'),
            art: getMasterRow('coverArt'),
            genre: getMasterRow('genre')
          },
          tracks: getTrackRows(),
          steerQuery: document.querySelector('input[data-testid="input-steer-album"]')?.value || '',
          steerArtistQuery: document.querySelector('input[data-testid="input-steer-artist"]')?.value || '',
          canFetchAnchor: Boolean(document.querySelector('[data-testid="btn-fetch-anchor"]')),
          canStage: Boolean(document.querySelector('[data-testid="btn-stage-next"]'))
        };
      })()
    `);
  }

  /**
   * Multimodal Decision Engine:
   * 1. If GEMINI_API_KEY is present in env, calls Gemini 2.5 Flash Vision.
   * 2. Otherwise, executes the comprehensive deterministic P1 -> P4 Priority Gate & Consensus Audit.
   */
  private async decideNextAction(state: any, screenshotBase64: string, turn: number): Promise<AgentAction> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      try {
        const aiAction = await this.callGeminiVision(apiKey, state, screenshotBase64, turn);
        if (aiAction) return aiAction;
      } catch (err) {
        console.warn('⚠️ Gemini Vision call failed. Falling back to deterministic Priority Gate:', err);
      }
    }

    return this.decideDeterministicAction(state);
  }

  private async callGeminiVision(apiKey: string, state: any, screenshotBase64: string, turn: number): Promise<AgentAction | null> {
    const prompt = `You are a music librarian QA tester auditing the Cadence Curate interface.
Observe the screenshot and DOM state. Follow the P1 -> P4 Priority Gate strictly:
P1: Container Identity (Title, Artist, Composer, Year, Art, Genre)
P2: File-to-Track Alignment (Unmapped files, sequence shifts)
P3: Granular Credits (Song titles, authentic vocalists vs composer)
P4: Staging (Click "Stage & Next" once clean)

Escalation Ladder:
- Audit Consensus: If 2+ external providers agree on a value and Selected Output differs, click that provider cell and report a Consensus/Selection Bug.
- If rip tags exist (e.g. CD RIP, - EP) and providers have clean title, adopt it. If providers also have rip tags, STEER with clean title.
- If local cover art exists and Selected has "No Art", adopt Local Art ([data-testid="master-cell-coverArt-local"]).
- If tracks have authentic playback singers in Gemini AI column ([data-testid="track-cell-N-ai"]), adopt them.

Action History:
${this.stepTrace.map((t) => `Step ${t.step}: ${t.action} (${t.reasoning})`).join('\n')}

Return ONLY JSON matching:
{
  "action": "CLICK" | "STEER" | "EDIT" | "STAGE" | "WAIT",
  "targetSelector": "CSS selector to click",
  "targetDescription": "Human readable description",
  "value": "text to type if STEER/EDIT",
  "priorityLevel": "P1" | "P2" | "P3" | "P4",
  "reasoning": "why you chose this action",
  "detectedBugs": [
    {
      "classification": "Consensus/Selection Bug" | "Identity Resolution Bug" | "Provider Retrieval Bug" | "Reconciliation Bug",
      "severity": "BLOCKER" | "MAJOR" | "MINOR",
      "description": "...",
      "expected": "...",
      "actual": "..."
    }
  ]
}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/png', data: screenshotBase64 } },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return JSON.parse(text) as AgentAction;
    }
    return null;
  }

  private decideDeterministicAction(state: any): AgentAction {
    const master = state.master || {};
    const tracks = state.tracks || [];
    const bugs: BugRecord[] = [];

    // --- P1: Container Identity ---

    // 1. Audit Auto-Consensus for Title
    const titleRow = master.title;
    if (titleRow) {
      const selected = titleRow.selected || '';
      const apple = titleRow.apple || '';
      const mb = titleRow.musicbrainz || '';
      const ai = titleRow.ai || '';

      const isRipTag = /cd\s*rip/i.test(selected) || /-\s*ep/i.test(selected);

      // Check if 2+ providers agree on a clean title
      const candidates = [apple, mb, ai].filter((t) => t && t !== '—' && t !== '-' && !/cd\s*rip/i.test(t));
      const hasConsensus = candidates.length >= 2 && candidates[0] === candidates[1];

      if (isRipTag) {
        if (hasConsensus && selected !== candidates[0]) {
          bugs.push({
            classification: 'Consensus/Selection Bug',
            severity: 'MAJOR',
            albumId: '',
            stepNumber: 0,
            description: `Auto-consensus failed on Album Title: 2+ providers agree on "${candidates[0]}", but Selected kept raw rip tag "${selected}".`,
            expected: candidates[0],
            actual: selected,
          });
          return {
            action: 'CLICK',
            targetSelector: '[data-testid="master-cell-albumTitle-apple"]',
            targetDescription: `Adopt consensus Album Title: "${candidates[0]}"`,
            priorityLevel: 'P1',
            reasoning: 'Selected title has raw rip tag; adopting provider consensus title.',
            detectedBugs: bugs,
          };
        }

        // Single clean candidate from Gemini AI
        if (ai && ai !== '—' && !/cd\s*rip/i.test(ai)) {
          return {
            action: 'CLICK',
            targetSelector: '[data-testid="master-cell-albumTitle-ai"]',
            targetDescription: `Adopt clean Gemini AI Album Title: "${ai}"`,
            priorityLevel: 'P1',
            reasoning: 'Selected title contains raw folder/rip tag; Gemini AI provides clean title.',
          };
        }

        // Steer with cleaned title
        const cleanQuery = selected.replace(/cd\s*rip/i, '').replace(/-\s*ep/i, '').trim();
        if (cleanQuery && cleanQuery !== selected) {
          return {
            action: 'STEER',
            value: cleanQuery,
            targetDescription: `Steer Providers with cleaned title: "${cleanQuery}"`,
            priorityLevel: 'P1',
            reasoning: 'All current providers reflect raw rip tag; steering upstream search with sanitized album title.',
          };
        }
      }
    }

    // 2. Audit Auto-Consensus & Performer Contamination for Album Artist (Container Identity)
    const artistRow = master.artist;
    if (artistRow) {
      const selected = (artistRow.selected || '').trim();
      const apple = (artistRow.apple || '').trim();
      const mb = (artistRow.musicbrainz || '').trim();
      const ai = (artistRow.ai || '').trim();

      const isValid = (val: string) => {
        if (!val) return false;
        const stripped = val.replace(/[\u2014\u2013\-\s]/g, '').trim();
        return stripped !== '' && !/unknown/i.test(stripped) && !stripped.includes('Action Required');
      };

      // Check external provider candidates
      const providerEntries: { col: 'apple' | 'musicbrainz' | 'ai'; val: string }[] = [];
      if (isValid(apple)) providerEntries.push({ col: 'apple', val: apple });
      if (isValid(mb)) providerEntries.push({ col: 'musicbrainz', val: mb });
      if (isValid(ai)) providerEntries.push({ col: 'ai', val: ai });

      // Check composer row as well (in Indian film soundtracks, composer is the canonical container artist)
      const composerRow = master.composer;
      const composerCandidates = [
        composerRow?.selected,
        composerRow?.ai,
        composerRow?.apple,
        composerRow?.musicbrainz,
        composerRow?.local,
      ].filter(isValid);
      const composer = composerCandidates[0] || '';

      // Gather track performers to detect if container artist is polluted by a single track singer
      const trackPerformers = new Set<string>();
      for (const t of tracks) {
        const performers = [t.localArtist, t.selectedArtist, t.aiArtist].filter(Boolean);
        for (const p of performers) {
          const split = p.split(/s*(?:&|,|and)s*/i);
          for (const s of split) {
            const clean = s.trim().toLowerCase();
            if (clean && clean.length > 2) trackPerformers.add(clean);
          }
          if (p.trim().length > 2) trackPerformers.add(p.trim().toLowerCase());
        }
      }

      // Determine external provider consensus
      let consensusArtist = '';
      let consensusCol: 'apple' | 'musicbrainz' | 'ai' | null = null;

      if (providerEntries.length >= 2) {
        for (let j = 0; j < providerEntries.length; j++) {
          for (let k = j + 1; k < providerEntries.length; k++) {
            if (providerEntries[j].val.toLowerCase() === providerEntries[k].val.toLowerCase()) {
              consensusArtist = providerEntries[j].val;
              consensusCol = providerEntries[j].col;
              break;
            }
          }
          if (consensusArtist) break;
        }
      }

      // If no 2-provider consensus, check if a provider matches composer
      if (!consensusArtist && composer) {
        const match = providerEntries.find(
          (p) => p.val.toLowerCase().includes(composer.toLowerCase()) || composer.toLowerCase().includes(p.val.toLowerCase())
        );
        if (match) {
          consensusArtist = match.val;
          consensusCol = match.col;
        }
      }

      // If still no consensus, check Gemini AI or single provider
      if (!consensusArtist && isValid(ai)) {
        consensusArtist = ai;
        consensusCol = 'ai';
      } else if (!consensusArtist && providerEntries.length > 0) {
        consensusArtist = providerEntries[0].val;
        consensusCol = providerEntries[0].col;
      }

      // Is selected equal to the primary composer?
      const isComposer = Boolean(composer && selected && selected.toLowerCase() === composer.toLowerCase());

      // Is selected equal to a single track performer when not the primary composer?
      const isSingleTrackPerformer = !isComposer && Boolean(
        selected &&
          Array.from(trackPerformers).some((p) => {
            const sLower = selected.toLowerCase();
            return sLower === p || sLower.includes(p) || p.includes(sLower);
          })
      );

      const targetArtist = consensusArtist || composer;
      const hasMismatch = targetArtist && selected.toLowerCase() !== targetArtist.toLowerCase();
      const providersUnpopulated = providerEntries.length === 0;

      if ((isSingleTrackPerformer && targetArtist && hasMismatch) || (hasMismatch && consensusArtist)) {
        bugs.push({
          classification: 'Identity Resolution Bug',
          severity: 'MAJOR',
          albumId: '',
          stepNumber: 0,
          description: isSingleTrackPerformer
            ? `Album Artist is contaminated with single track performer "${selected}", while provider/composer consensus points to "${targetArtist}".`
            : `Auto-consensus failed on Album Artist: Providers agree on "${targetArtist}", but Selected is "${selected || '(Empty)'}".`,
          expected: targetArtist,
          actual: selected || '(Empty)',
        });

        if (consensusCol) {
          return {
            action: 'CLICK',
            targetSelector: `[data-testid="master-cell-albumArtist-${consensusCol}"]`,
            targetDescription: `Adopt consensus Album Artist: "${consensusArtist}" from ${consensusCol}`,
            priorityLevel: 'P1',
            reasoning: isSingleTrackPerformer
              ? `Selected artist "${selected}" is a single track performer; switching to container artist "${consensusArtist}".`
              : `Selected artist "${selected}" does not match provider consensus "${consensusArtist}".`,
            detectedBugs: bugs,
          };
        } else if (state.canFetchAnchor || providersUnpopulated) {
          return {
            action: 'STEER',
            value: master.title?.selected || '',
            artistValue: targetArtist,
            targetDescription: `Steer Providers with title "${master.title?.selected}" and artist "${targetArtist}" to resolve container consensus`,
            priorityLevel: 'P1',
            reasoning: `Selected album artist "${selected}" is contaminated and external providers are unpopulated. Triggering provider search to resolve consensus.`,
            detectedBugs: bugs,
          };
        } else if (targetArtist) {
          return {
            action: 'EDIT',
            targetSelector: '[data-testid="btn-edit-master-albumArtist"]',
            value: targetArtist,
            targetDescription: `Edit Album Artist manually to: "${targetArtist}"`,
            priorityLevel: 'P1',
            reasoning: `No provider cell contains "${targetArtist}"; editing master Album Artist manually.`,
            detectedBugs: bugs,
          };
        }
      } else if (isSingleTrackPerformer && providersUnpopulated && state.canFetchAnchor) {
        return {
          action: 'STEER',
          value: master.title?.selected || '',
          artistValue: composer || '',
          targetDescription: `Steer Providers with album title "${master.title?.selected}" to resolve container artist`,
          priorityLevel: 'P1',
          reasoning: `Selected album artist "${selected}" appears to be a single track performer. Fetching external providers to determine authentic container artist.`,
        };
      }
    }

    // 3. Cover Artwork Resolution
    const artRow = master.art;
    if (artRow) {
      const local = artRow.local || '';
      const selected = artRow.selected || '';
      if (local.includes('Local Tag') && (selected.includes('No Art') || !selected)) {
        return {
          action: 'CLICK',
          targetSelector: '[data-testid="master-cell-coverArt-local"]',
          targetDescription: 'Adopt Local File Tag artwork into Selected Output',
          priorityLevel: 'P1',
          reasoning: 'Local cover art is present in container but Selected Output is empty.',
        };
      }
    }

    // --- P2 & P3: Track-Level Metadata & Playback Singers ---
    for (let i = 0; i < tracks.length; i++) {
      const trk = tracks[i];
      const selected = trk.selected || '';
      const ai = trk.ai || '';

      // Check for raw filename artifacts
      if (/^\d+\s*[-.]\s*/.test(selected) || /track\s*\d+/i.test(selected) || /\.(flac|mp3|wav)/i.test(selected)) {
        if (ai && !/^\d+\s*[-.]\s*/.test(ai)) {
          return {
            action: 'CLICK',
            targetSelector: `[data-testid="track-cell-${i}-ai"]`,
            targetDescription: `Adopt sanitized title for track #${i + 1} from Gemini AI`,
            priorityLevel: 'P3',
            reasoning: `Selected song title on track #${i + 1} contains file system debris ("${selected}").`,
          };
        }
      }

      // Check for playback singers
      if (ai && !ai.includes('(Composer)') && ai !== '—' && !selected.includes(ai)) {
        return {
          action: 'CLICK',
          targetSelector: `[data-testid="track-cell-${i}-ai"]`,
          targetDescription: `Adopt playback singer for track #${i + 1} from Gemini AI`,
          priorityLevel: 'P3',
          reasoning: `Track #${i + 1} has authentic playback singer in Gemini AI column.`,
        };
      }
    }

    // --- P4: Staging ---
    return {
      action: 'STAGE',
      targetDescription: 'Click "Stage & Next"',
      priorityLevel: 'P4',
      reasoning: 'Container identity and track metadata satisfy release coherence. Ready to stage.',
    };
  }

  /**
   * Pre-Staging Invariant & Ground Truth Verification against Oracle
   */
  private async verifyReleaseAgainstOracle(albumId: string, initialTitle: string, screenshotPath: string, oracle: AlbumOracleManifest | null) {
    console.log(`\n🔍 [Evaluator] Asserting Invariants for "${initialTitle}" BEFORE Staging...`);

    if (!oracle) {
      console.log(`ℹ️ No static Oracle fixture entry for "${initialTitle}". Recorded as Test Oracle Gap.`);
      this.recordBug({
        classification: 'Test Oracle Gap',
        severity: 'MINOR',
        albumId,
        stepNumber: 0,
        description: `No authoritative ground truth entry in oracle.json for album "${initialTitle}".`,
        expected: 'Static test fixture entry',
        actual: 'Missing oracle entry',
        screenshotPath,
      });
      return;
    }
    console.log(`📖 Ground Truth Oracle Loaded: "${oracle.canonical_title}" (${oracle.release_year}) by ${oracle.canonical_artist}`);

    const state = await this.extractCockpitState();
    const master = state.master || {};
    const tracks = state.tracks || [];

    // Assert Album Title
    const selectedTitle = master.title?.selected || '';
    if (!selectedTitle.toLowerCase().includes(oracle.canonical_title.toLowerCase())) {
      this.recordBug({
        classification: 'Identity Resolution Bug',
        severity: 'MAJOR',
        albumId,
        stepNumber: 0,
        description: `Album Title mismatch against Oracle ground truth.`,
        expected: oracle.canonical_title,
        actual: selectedTitle,
        screenshotPath,
      });
    }

    // Assert Album Artist
    const selectedArtist = master.artist?.selected || '';
    if (oracle.canonical_artist && !selectedArtist.toLowerCase().includes(oracle.canonical_artist.toLowerCase())) {
      this.recordBug({
        classification: 'Identity Resolution Bug',
        severity: 'MAJOR',
        albumId,
        stepNumber: 0,
        description: `Album Artist mismatch against Oracle ground truth.`,
        expected: oracle.canonical_artist,
        actual: selectedArtist,
        screenshotPath,
      });
    }

    // Assert Track Singers & Titles
    for (const oracleTrack of oracle.tracks) {
      const match = tracks.find(
        (t: any) =>
          (t.selectedTitle && t.selectedTitle.toLowerCase().includes(oracleTrack.title.toLowerCase())) ||
          (t.selected && t.selected.toLowerCase().includes(oracleTrack.title.toLowerCase())) ||
          t.index + 1 === oracleTrack.track_number
      );
      if (match) {
        const selectedText = match.selectedArtist || match.selected || '';
        const aiText = match.aiArtist || match.ai || '';

        // Extract discrete credited vocalist tokens from selected and ai
        const rawCredited = (match.selectedArtist || match.selected || '')
          .split(/\s*(?:&|,|\band\b|\/\/)\s*/i)
          .map((s: string) => s.trim())
          .filter((s: string) => s && s.length > 2 && !s.includes('Track') && !s.includes('Requires Action') && s !== match.selectedTitle);

        // 1. If primary_artists is explicitly specified on oracleTrack, ensure each primary vocalist is credited
        if (oracleTrack.primary_artists && oracleTrack.primary_artists.length > 0) {
          for (const primary of oracleTrack.primary_artists) {
            const hasPrimary = matchesSingerAlias(selectedText, primary) || matchesSingerAlias(aiText, primary);
            if (!hasPrimary) {
              this.recordBug({
                classification: 'Reconciliation Bug',
                severity: 'MAJOR',
                albumId,
                stepNumber: 0,
                description: `Primary playback singer "${primary}" missing from Track #${oracleTrack.track_number} ("${oracleTrack.title}").`,
                expected: `Primary singer ${primary} credited`,
                actual: `Selected: ${match.selected}, AI: ${match.ai}`,
                screenshotPath,
              });
            }
          }
        } else {
          // 2. Multi-singer pool check: Ensure at least one authentic vocalist from the allowed pool is credited
          const allowedPool = oracleTrack.artists;
          const matchingPoolArtists = allowedPool.filter(
            (oracleSinger) => matchesSingerAlias(selectedText, oracleSinger) || matchesSingerAlias(aiText, oracleSinger)
          );

          if (matchingPoolArtists.length === 0) {
            this.recordBug({
              classification: 'Reconciliation Bug',
              severity: 'MAJOR',
              albumId,
              stepNumber: 0,
              description: `No credited vocalists on Track #${oracleTrack.track_number} ("${oracleTrack.title}") match the allowed artist pool: [${allowedPool.join(', ')}].`,
              expected: `At least one vocalist from [${allowedPool.join(', ')}] credited`,
              actual: `Selected: ${match.selected}, AI: ${match.ai}`,
              screenshotPath,
            });
          }
        }

        // 3. Verify that all credited vocalists match against the allowed artist pool (or the release composer/artist)
        for (const credited of rawCredited) {
          const isAllowed =
            oracleTrack.artists.some((oracleSinger) => matchesSingerAlias(credited, oracleSinger)) ||
            (oracle.canonical_composer && matchesSingerAlias(credited, oracle.canonical_composer)) ||
            (oracle.canonical_artist && matchesSingerAlias(credited, oracle.canonical_artist));

          if (!isAllowed) {
            this.recordBug({
              classification: 'Reconciliation Bug',
              severity: 'MAJOR',
              albumId,
              stepNumber: 0,
              description: `Credited vocalist "${credited}" on Track #${oracleTrack.track_number} ("${oracleTrack.title}") is not in the allowed artist pool.`,
              expected: `One of: ${oracleTrack.artists.join(', ')} (or composer ${oracle.canonical_composer})`,
              actual: `Credited: "${credited}" in [${rawCredited.join(', ')}]`,
              screenshotPath,
            });
          }
        }
      }
    }

    console.log(`✨ Pre-Staging Verification Complete for "${initialTitle}".`);
  }

  private recordBug(bug: BugRecord) {
    const albumKey = bug.albumId || 'current';
    const dedupKey = `${albumKey}:${bug.classification}:${bug.description.trim()}`;
    if (this.recordedBugKeys.has(dedupKey)) {
      return;
    }
    this.recordedBugKeys.add(dedupKey);
    this.bugs.push(bug);
    console.log(`🚨 [BUG DETECTED] [${bug.classification}] (${bug.severity}): ${bug.description}`);
  }

  private generateDefectReport() {
    const reportPath = path.join(this.reportsDir, 'curate-qa-report.md');
    console.log(`\n📄 Generating Multimodal Quality Testing Report at ${reportPath}...`);

    let md = `# Cadence Curate Multimodal QA Agent Report\n\n`;
    md += `**Execution Time:** ${new Date().toISOString()}\n`;
    md += `**Total Steps Executed:** ${this.stepTrace.length}\n`;
    md += `**Total Bugs Detected:** ${this.bugs.length}\n\n`;

    md += `## 1. Executive Summary\n\n`;
    if (this.bugs.length === 0) {
      md += `✅ **PASS**: All tested releases satisfied the P1 → P4 Priority Gate, Consensus Auditing, and Ground Truth Invariants.\n\n`;
    } else {
      md += `⚠️ **FINDINGS**: Detected ${this.bugs.length} issues across the curation journey.\n\n`;
    }

    md += `### Bug Classification Breakdown\n\n`;
    md += `| Bug Classification | Count | Severity |\n`;
    md += `| :--- | :---: | :--- |\n`;
    const bugCounts = new Map<string, number>();
    for (const b of this.bugs) {
      bugCounts.set(b.classification, (bugCounts.get(b.classification) || 0) + 1);
    }
    for (const [cls, cnt] of bugCounts.entries()) {
      md += `| **${cls}** | ${cnt} | ${cnt > 0 ? 'Review Required' : 'Clean'} |\n`;
    }
    md += `\n---\n\n`;

    md += `## 2. Detailed Bug Findings\n\n`;
    if (this.bugs.length === 0) {
      md += `*No defects identified.*\n\n`;
    } else {
      for (const [idx, bug] of this.bugs.entries()) {
        md += `### Issue ${idx + 1}: ${bug.description}\n`;
        md += `- **Classification:** \`${bug.classification}\`\n`;
        md += `- **Severity:** \`${bug.severity}\`\n`;
        md += `- **Album ID:** \`${bug.albumId}\`\n`;
        md += `- **Expected:** ${bug.expected}\n`;
        md += `- **Actual:** ${bug.actual}\n`;
        if (bug.screenshotPath) {
          md += `- **Evidence Screenshot:** \`${bug.screenshotPath}\`\n`;
        }
        md += `\n`;
      }
    }

    md += `## 3. Step Execution Trace\n\n`;
    md += `| Step | Priority & Action | Reasoning |\n`;
    md += `| :---: | :--- | :--- |\n`;
    for (const t of this.stepTrace) {
      md += `| ${t.step} | ${t.action} | ${t.reasoning} |\n`;
    }
    md += `\n`;

    fs.writeFileSync(reportPath, md, 'utf8');
    console.log(`✅ Defect report written successfully to ${reportPath}`);
  }
}

// CLI Execution Entry Point
if (process.argv[1] && process.argv[1].endsWith('curateQaAgent.ts')) {
  const queryArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const agent = new CurateMultimodalQaAgent();
  agent.run(queryArg).catch((err) => {
    console.error('❌ QA Agent Failed:', err);
    process.exit(1);
  });
}
