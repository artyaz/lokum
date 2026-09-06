import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import listingRoutes from './routes/listings.js';
import listingDetailRoutes from './routes/listing-detail.js';
import savedRoutes from './routes/saved.js';
import cronJobRoutes from './routes/cron_jobs.js';
import cronRunRoutes from './routes/cron_runs.js';
import regionRoutes from './routes/regions.js';
import telegramRoutes from './routes/telegram.js';
import facebookSessionRoutes from './routes/facebook-session.js';
import duplicatesRoutes from './routes/duplicates.js';
import importRoutes from './routes/import.js';
import sharePageRoutes from './routes/share-page.js';
import poiRoutes from './routes/pois.js';
import { initScheduler } from './services/cron.js';
import { initAlwaysOn, shutdownAlwaysOn } from './services/alwaysOn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '9120');

app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || true,
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust the nginx proxy so X-Forwarded-* headers are honored
// (needed for WebAuthn origin verification & secure cookies)
app.set('trust proxy', 1);

// healthcheck
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/listings', listingDetailRoutes);  // translate + share + pois endpoints
app.use('/api', listingDetailRoutes);  // /api/public/:token
app.use('/api/saved', savedRoutes);
app.use('/api/cron-jobs', cronJobRoutes);
app.use('/api/cron-runs', cronRunRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/facebook', facebookSessionRoutes);
app.use('/api/duplicates', duplicatesRoutes);
app.use('/api/import', importRoutes);
app.use('/api/pois', poiRoutes);

// Server-rendered public share page (/s/:token) — OG meta so Telegram and
// other messengers render the photo preview when a link is pasted.
app.use('/s', sharePageRoutes);

// Serve built frontend (../frontend/dist), unless API-only mode.
// SERVE_FRONTEND=0 turns this server into a pure JSON API for a split
// deploy (UI on Vercel calling this backend + cron on the backend).
// Default '1' preserves the current same-origin behaviour.
const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (process.env.SERVE_FRONTEND === '0') {
  console.log('[server] SERVE_FRONTEND=0 → API-only mode (frontend not served)');
  app.get(/^(?!\/api|\/s\/).*/, (req, res) => res.status(404).json({ error: 'frontend_disabled' }));
} else if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api|\/s\/).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// HTTP keep-alive tuning (Task A8).
//
// Node 18+'s global `fetch` is undici, but the `undici` bare specifier is
// not a built-in importable — it must be installed as a real dependency
// (added to package.json). The dynamic import + try/catch keeps the server
// booting even if `npm install` hasn't run yet (the default global
// dispatcher still works, just with looser keep-alive).
//
// Tightening `connections` to 6 caps the per-origin concurrent socket count
// so a single scraper can't accidentally fan out 100+ parallel fetches
// (undici's default `connections` is effectively unlimited per origin).
// `keepAliveTimeout` of 10 s reuses sockets across the multiple HTTP calls
// a single scraper makes to the same host within a run; `keepAliveMaxTimeout`
// of 30 s caps idle socket retention between runs so the always-on server
// doesn't accumulate dormant keep-alive sockets.
async function setupNetworkDispatcher() {
  try {
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new Agent({
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
      connections: 6,
    }));
    console.log('[server] undici global dispatcher set (keepAlive 10s/30s, 6 conns/host)');
  } catch (e) {
    console.warn('[server] undici not available — using Node default fetch dispatcher:', e.message);
  }
}

// Graceful shutdown (Task A8).
//
// SIGTERM (systemd, docker, kill) / SIGINT (Ctrl-C). Closes in this order:
//   1. Stop accepting new HTTP work — `app.listen` returns a server handle
//      we use to call `.close()` (in-flight requests get a few seconds to
//      finish; new ones are refused).
//   2. SIGTERM all scraper children spawned via services/spawn.js, then
//      SIGKILL 2 s later if still alive.
//   3. Close the Playwright singleton (kills the chromium child + IPC pipe
//      that otherwise keeps the event loop alive).
//   4. Close the pg pool.
//   5. process.exit(0).
//
// A 5 s hard-backstop timer ensures we exit even if a child or Playwright
// refuses to die — no linger beyond 5 s.
let shuttingDown = false;
let serverHandle = null;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down (≤5s)`);

  const killTimer = setTimeout(() => {
    console.error('[server] graceful shutdown exceeded 5s — forcing exit');
    process.exit(1);
  }, 5000);
  killTimer.unref();

  // 1. Stop accepting new connections. In-flight req/res get up to the 5s
  //    backstop to finish.
  try { serverHandle?.close(); } catch {}

  // 2. SIGTERM all scraper children, escalate to SIGKILL after 2s.
  try {
    const { killAllChildren } = await import('./services/spawn.js');
    killAllChildren('SIGTERM');
    setTimeout(() => killAllChildren('SIGKILL'), 2000).unref();
  } catch (e) {
    console.error('[server] killAllChildren failed:', e.message);
  }

  // 3. Close the Playwright singleton (no-op if it was never launched).
  try {
    const { closeBrowser } = await import('./services/browser.js');
    await closeBrowser();
  } catch (e) {
    console.error('[server] closeBrowser failed:', e.message);
  }

  // 3b. Close the always-on watcher's persistent contexts + watcher browser.
  // Separate from closeBrowser() because the watcher uses its own Chromium
  // instance + per-platform persistent contexts (Task I — H4 design). No-op
  // if the watcher was never initialized.
  try {
    await shutdownAlwaysOn();
  } catch (e) {
    console.error('[server] shutdownAlwaysOn failed:', e.message);
  }

  // 4. Close the pg pool.
  try {
    const { pool } = await import('./db.js');
    await pool.end();
  } catch (e) {
    console.error('[server] pool.end failed:', e.message);
  }

  console.log('[server] shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function start() {
  await setupNetworkDispatcher();

  if (process.env.FAKE_DB === '1') {
    try {
      const { runStartupScan } = await import('./fakedb/index.js');
      await runStartupScan();
    } catch (e) {
      console.error('[server] fake dedupe scan failed:', e.message);
    }
  }

  // Start scheduler (only user-defined cron jobs — no built-in default).
  // Skipped in oneshot mode (LOKUM_ONESHOT=1) — that mode is intended for
  // src/run_cron.js which doesn't import this file at all, but the gate
  // here is defensive so a stray LOKUM_ONESHOT env on the server doesn't
  // leave node-cron timers ticking in the always-on server.
  if (process.env.LOKUM_ONESHOT === '1') {
    console.log('[server] LOKUM_ONESHOT=1 → skipping node-cron scheduler init');
  } else {
    try {
      await initScheduler();
    } catch (e) {
      console.error('[server] scheduler init failed:', e.message);
    }
  }

  // Always-on watcher (Task I — H4 design). Started AFTER the scheduler so
  // the in-memory mutex (`isFullCronRunning()`) is wired before any tick
  // fires. Skipped in LOKUM_ONESHOT mode (CLI mode — no long-lived
  // process). Disabled via LOKUM_ALWAYS_ON=0. Wrapped in try/catch so a
  // launch failure (e.g. Playwright not installed on the dev machine, or
  // a misconfigured proxy) logs an error and the rest of the server
  // continues without the watcher — the full-cron ground-truth re-sync
  // every ~30 min still runs.
  if (process.env.LOKUM_ONESHOT === '1') {
    console.log('[server] LOKUM_ONESHOT=1 → skipping always-on watcher init');
  } else if (process.env.LOKUM_ALWAYS_ON === '0') {
    console.log('[server] LOKUM_ALWAYS_ON=0 → skipping always-on watcher init');
  } else {
    try {
      await initAlwaysOn();
    } catch (e) {
      console.error('[server] always-on watcher init failed (server will continue without watcher):', e.message);
    }
  }

  serverHandle = app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] Lokum backend on http://127.0.0.1:${PORT}`);
  });
}

start().catch(e => {
  console.error('[server] FATAL:', e);
  process.exit(1);
});
