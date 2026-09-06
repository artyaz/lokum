// Shared headless Chromium (Playwright) — lazy singleton.
// Used as a fallback for sources that block plain fetch (bot protection).
//
// Memory/CPU optimizations (Task A2):
// - Per-context route() aborts images, fonts, media, stylesheets, and known
//   ad/analytics hosts. A typical listing search page ships 1–4 MB of binary
//   assets; aborting them at the network layer keeps the page's resident
//   memory ~1 order of magnitude lower and skips the decode/parse CPU work.
// - Default navigation timeout lowered from 45s to 15s (fail fast).
// - Default waitMs lowered from 2500 to 1500ms — most SSR pages are usable
//   at domcontentloaded + a short settle delay; callers that need more can
//   still pass an explicit value.
// - page is always closed in a `finally` so a thrown goto/content cannot
//   leak a tab (a leaked tab keeps its full DOM + image bitmaps resident
//   until the next idle browser close — up to 60s after the run).
// - Reusable shared context: chromium.newContext() is comparatively cheap,
//   but each one carries its own cookie jar + service worker spawner. We
//   create one context per fetchRendered call and tear it down immediately
//   so no per-tab state survives across runs.
//
// Idle lifecycle & oneshot mode (Task A1):
// - scheduleIdleClose() sets an unref'd setTimeout to close the singleton
//   IDLE_CLOSE_MS after the last fetch. The timer not being ref'd means
//   the timer itself doesn't keep the loop alive, BUT the Chromium child
//   process + its IPC pipe DOES, so a CLI run that used the browser would
//   hang for IDLE_CLOSE_MS after the work is done if it didn't explicitly
//   close. CLI entry points (run_scrape.js, run_cron.js) therefore call
//   closeBrowser() before pool.end()/process.exit().
// - LOKUM_ONESHOT=1 lowers the default idle window to 5s (the gap between
//   scrapes inside one run is short, and the process exits between ticks).
//
// Always-on fetcher (Task I — H4 design):
// - A SEPARATE Chromium instance + per-platform persistent BrowserContexts
//   live alongside the on-demand singleton above. See the bottom of this
//   file (getPersistentContext / closePersistentContexts). Kept separate so
//   fetchRendered's per-call context lifecycle (open/close/idle-close)
//   doesn't interfere with the watcher's long-lived contexts, and so
//   closeBrowser() (oneshot CLI) doesn't tear down watcher contexts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let browserPromise = null;
let idleTimer = null;
const IDLE_CLOSE_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.SCRAPER_BROWSER_IDLE_MS ||
      (process.env.LOKUM_ONESHOT === '1' ? '5000' : '30000'),
    10
  ) || 30000
);

// Resource types we never need for HTML scraping. Keeping the list narrow
// avoids accidentally breaking JSON-LD/Next.js pages (script + xhr + fetch
// all stay enabled).
const BLOCKED_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'eventsource',
  'manifest',
  'other' // favicons, etc.
]);

// Hosts whose requests are pure ad/analytics noise on the Polish listing
// sites we scrape. Aborting these cuts CPU + main-thread contention.
const BLOCKED_HOST_RE = /(^|\.)(doubleclick\.net|googletagmanager\.com|google-analytics\.com|googlesyndication\.com|google\.[a-z]+\/(ads|pagead)|adservice\.google\.|facebook\.com\/tr|connect\.facebook\.net|hotjar\.com|segment\.io|segment\.com|amplitude\.com|fullstory\.com|sentry\.io|snowplowanalytics\.com|bat\.bing\.com|clarity\.ms|yandex\.ru\/metrica|gemius\.pl|adresowo\.pl\/(?:c|r)|mc\.yandex\.ru)$/i;

// Build a Playwright route handler that aborts ads/fonts/css/images and
// known analytics hosts, letting everything else through.
function makeRouteHandler() {
  return async (route, request) => {
    try {
      const url = request.url();
      if (BLOCKED_HOST_RE.test(url)) {
        return route.abort('blockedbyclient');
      }
      const type = request.resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    } catch {
      // route() can throw if the page navigated away mid-request; safe to skip.
      try { return route.continue(); } catch {}
    }
  };
}

// Stealth init script — runs before any page script on every navigation.
// Patches the well-known automation fingerprints Cloudflare/imperva probe:
//   - navigator.webdriver  → false (the most common signal)
//   - window.chrome         → looks like a real Chrome
//   - navigator.plugins     → non-empty (headless ships an empty array)
//   - navigator.languages   → ['pl-PL', 'pl', 'en']
//   - WebGL vendor/renderer → generic Intel strings (default headless = Google)
// The `--disable-blink-features=AutomationControlled` flag already strips the
// outermost CDP signal, but Cloudflare's botd/heuristics check these too.
const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' }
  ]
});
window.chrome = window.chrome || { runtime: {}, loadTimes: function(){return{};}, csi: function(){return{};}, app: {} };
try {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';
    if (p === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, p);
  };
} catch (_) {}
`;

export async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          // Reduce per-tab memory: don't keep image cache in memory.
          '--enable-low-res-tiling',
          // Smaller image decode cache, fewer GPU buffers.
          '--disable-features=PaintHolding,BackForwardCache',
          '--disable-gpu'
        ]
      });
      console.log('[browser] chromium launched');
      return browser;
    })();
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeBrowser().catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

// Fetch a page's rendered HTML through the browser.
//
// Notes:
// - `waitUntil: 'domcontentloaded'` is lighter than `load` (no CSS/img/iframe
//   onload waits). For SSR JSON-LD sites this is the right level.
// - Route interception is installed BEFORE goto, so aborted sub-requests
//   never allocate a NetworkManager entry for the asset body.
// - page is explicitly closed in `finally` to guarantee no tab leak.
export async function fetchRendered(url, { waitMs = 1500, timeout = 15000, blockResources = true } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'pl-PL',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' }
  });
  // Inject stealth patches BEFORE any page script runs. addInitScript runs
  // on every navigation (including same-document navigations) and is the
  // earliest hook Playwright exposes — earlier than Page.addScriptToEvaluateOnNewDocument.
  await ctx.addInitScript(STEALTH_INIT);
  let page;
  try {
    page = await ctx.newPage();
    if (blockResources) {
      // `route` runs per main-frame request. The `**/*` pattern also covers
      // iframe subrequests, so ads inside iframes are aborted too.
      await page.route('**/*', makeRouteHandler());
    }
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!resp || resp.status() >= 400) {
      throw new Error(`HTTP ${resp ? resp.status() : 'no-response'}`);
    }
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    return await page.content();
  } finally {
    if (page) {
      try { await page.close({ runBeforeUnload: false }); } catch {}
    }
    await ctx.close().catch(() => {});
    scheduleIdleClose();
  }
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
    browserPromise = null;
  }
}

// ============================================================================
// Always-on fetcher (Task I — H4 design).
//
// Separate lifecycle from the on-demand singleton above:
//   - One Chromium process launched on initAlwaysOn() and kept alive for the
//     process lifetime (no idle-close — the watcher needs it warm at all
//     times). Headless with the same stealth flags + route interception as
//     fetchRendered.
//   - One persistent BrowserContext per platform slug, persisted to
//     `backend/.playwright-state/<slug>.json` (storageState). Cookies +
//     localStorage survive process restarts so Datadome/CloudFront see a
//     stable returning visitor instead of a fresh automation client every
//     cycle (the #4 anti-bot trigger cataloged in H4-§3.1).
//   - Each tick reuses the SAME context — no new TLS handshake, no new cookie
//     jar, no new tab creation. Saves ~2-3s overhead per fetch (H4-§5.1).
//
// The persistent contexts live in a separate `watcherBrowserPromise`
// instance from the on-demand `browserPromise` singleton above so that:
//   - fetchRendered's per-call context lifecycle (open / close / idle-close)
//     doesn't interfere with the watcher's long-lived contexts.
//   - closeBrowser() (called from oneshot CLI entry points) doesn't tear down
//     the watcher's contexts mid-tick.
// ============================================================================

const _WATCHER_DIRNAME = path.dirname(fileURLToPath(import.meta.url));
// backend/.playwright-state/ — sibling of `services/` parent's `src/` parent.
const STATE_DIR = path.resolve(_WATCHER_DIRNAME, '..', '..', '.playwright-state');

let watcherBrowserPromise = null;
const watcherContexts = new Map(); // slug -> BrowserContext

async function ensureStateDir() {
  try {
    await fs.promises.mkdir(STATE_DIR, { recursive: true });
  } catch {
    // Best-effort. The dir is created on first storageState write too.
  }
}

function statePathFor(slug) {
  return path.join(STATE_DIR, `${slug}.json`);
}

async function launchWatcherBrowser() {
  await ensureStateDir();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: process.env.ALWAYSON_HEADFUL === '1' ? false : true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--enable-low-res-tiling',
      '--disable-features=PaintHolding,BackForwardCache',
      '--disable-gpu'
    ]
  });
  console.log('[browser] watcher chromium launched');
  return browser;
}

// Get (or lazily create) the always-on watcher Chromium singleton. Wrapped
// in a Promise so concurrent callers coalesce on the same launch. On launch
// failure the Promise is reset so the next call retries.
export async function getWatcherBrowser() {
  if (!watcherBrowserPromise) {
    watcherBrowserPromise = launchWatcherBrowser();
    watcherBrowserPromise.catch(() => { watcherBrowserPromise = null; });
  }
  return watcherBrowserPromise;
}

// Get (or lazily create) a per-platform persistent BrowserContext. The
// context loads its storageState from `STATE_DIR/<slug>.json` if present
// (cookies + localStorage from a previous solve / visit). On close, the
// watcher calls `ctx.storageState({ path })` to persist the updated state
// back to disk (handled by alwaysOn.js#watchLoop).
//
// Proxies: H4-§4.9 — only Otodom gets a residential proxy override
// (`PROXY_OTODOM_URL`) and only when sustained block-rate > 5%. The env
// wiring is here so the operator can set it without code changes.
export async function getPersistentContext(slug) {
  if (watcherContexts.has(slug)) return watcherContexts.get(slug);
  const browser = await getWatcherBrowser();
  const statePath = statePathFor(slug);
  let storageState;
  try {
    await fs.promises.access(statePath);
    storageState = statePath;
  } catch {
    storageState = undefined; // first run — no saved state yet
  }

  const ctxOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'pl-PL',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' },
    storageState
  };

  // Per-platform proxy override (H4-§4.9). Currently only Otodom wires
  // here; other platforms fall through to the default (no proxy).
  const proxyEnv = `PROXY_${slug.toUpperCase()}_URL`;
  if (process.env[proxyEnv]) {
    ctxOptions.proxy = parseProxyUrl(process.env[proxyEnv]);
  }

  const ctx = await browser.newContext(ctxOptions);
  // Inject the same stealth init script as fetchRendered — webdriver=false,
  // chrome.runtime, plugins, WebGL vendor. Cloudflare/imperva probe these.
  await ctx.addInitScript(STEALTH_INIT);
  // Same resource-aborting route handler as fetchRendered — images/fonts/css/
  // analytics hosts are aborted at the network layer so each tick's resident
  // memory stays low (~200 MB across all persistent contexts).
  try {
    await ctx.route('**/*', makeRouteHandler());
  } catch {
    // `ctx.route` registers on the context-level network interceptor; if a
    // previous registration is still active (shouldn't happen on a fresh
    // context) Playwright throws — safe to ignore.
  }
  // On accidental context close (browser crashed, OOM), evict from cache so
  // the next call creates a fresh one.
  ctx.on('close', () => watcherContexts.delete(slug));
  watcherContexts.set(slug, ctx);
  console.log(`[browser] persistent context ready for "${slug}" (storageState=${storageState ? 'loaded' : 'fresh'})`);
  return ctx;
}

// Persist a context's current cookies + localStorage to disk so the next
// process restart re-loads them. Called by the watcher after each successful
// tick. Best-effort — failure here is logged but doesn't abort the tick.
export async function savePersistentContextState(slug) {
  const ctx = watcherContexts.get(slug);
  if (!ctx) return;
  try {
    await ensureStateDir();
    await ctx.storageState({ path: statePathFor(slug) });
  } catch (e) {
    console.warn(`[browser] savePersistentContextState(${slug}) failed:`, e.message);
  }
}

// Close + evict a single persistent context. Used by the circuit breaker
// when we want a fresh session (e.g. Otodom challenge likely cleared).
export async function closePersistentContext(slug) {
  const ctx = watcherContexts.get(slug);
  if (!ctx) return;
  watcherContexts.delete(slug);
  try { await ctx.close(); } catch {}
}

// Close all persistent contexts + the watcher browser. Called from
// index.js graceful shutdown. Idempotent.
export async function closePersistentContexts() {
  for (const slug of [...watcherContexts.keys()]) {
    await closePersistentContext(slug);
  }
  if (watcherBrowserPromise) {
    const b = await watcherBrowserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
    watcherBrowserPromise = null;
  }
}

function parseProxyUrl(raw) {
  // Accept either `http://host:port` or `http://user:pass@host:port`.
  // Returns Playwright's { server, username?, password? } shape.
  try {
    const u = new URL(raw);
    const out = { server: `${u.protocol}//${u.hostname}:${u.port || 80}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: raw };
  }
}
