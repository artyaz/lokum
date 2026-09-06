// CLI: cron runner — one-shot mode.
//
// Designed to be invoked by a system crontab line every minute (or every
// few minutes). On each invocation the process:
//   1. Boots, opens the DB pool.
//   2. Loads all enabled cron_jobs whose next_run_at <= NOW().
//   3. Runs each job's runFetchCycle sequentially (capped at maxJobsPerTick).
//   4. Updates next_run_at for each via scheduleNextRun().
//   5. Closes the browser singleton + the DB pool + calls process.exit(0).
//
// Between invocations the OS holds zero Node/Chromium state — true ~0 idle
// RAM and ~0 idle CPU. The always-on Express server (src/index.js) is not
// imported here, so no HTTP listener and no node-cron timers are created.
//
// Suggested crontab (root, on the server):
//   * * * * * cd /opt/lokum/backend && LOKUM_ONESHOT=1 node src/run_cron.js >> /var/log/lokum-cron.log 2>&1
//
// Or, to avoid waking the process when no job is due, run every 5 minutes:
//   */5 * * * * cd /opt/lokum/backend && LOKUM_ONESHOT=1 node src/run_cron.js >> /var/log/lokum-cron.log 2>&1
//
// Env:
//   LOKUM_ONESHOT=1          — shortens browser idle close window.
//   CRON_MAX_JOBS_PER_TICK   — override max jobs per tick (default 8).
//   CRON_TICK_SOFT_MS        — soft watchdog (default 600000 = 10 min).
//                              On fire: close pg pool + browser, then exit(2)
//                              so the next crontab minute can run cleanly.
//   CRON_TICK_HARD_MS        — hard watchdog (default 720000 = 12 min).
//                              On fire: process.exit(3) no matter what.
//                              Mirrors services/spawn.js's 10/12 min
//                              SIGTERM/SIGKILL contract for child processes.

import 'dotenv/config';
import { pool } from './db.js';
import { runDueJobs } from './services/cron.js';
import { shutdownRunner } from './services/runner.js';

// HTTP keep-alive tuning (Task A8): same dispatcher settings as the
// always-on server. The oneshot process is short-lived (~30–90 s) but a
// single tick still issues 10–100 fetches to the same per-source origin,
// so reusing sockets cuts handshake cost from ~150 ms to ~1 ms per call
// and bounds concurrent sockets to 6 per host.
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connections: 6,
  }));
  console.log('[run_cron] undici global dispatcher set');
} catch (e) {
  console.warn('[run_cron] undici not available — using Node default dispatcher:', e.message);
}

function fmtMem(m) {
  return `rss=${Math.round(m.rss/1024/1024)}MB heap=${Math.round(m.heapUsed/1024/1024)}MB ext=${Math.round(m.external/1024/1024)}MB`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`;
}

async function main() {
  const t0 = Date.now();
  const memStart = process.memoryUsage();
  console.log(`[run_cron] tick start | ${new Date().toISOString()} | ${fmtMem(memStart)}`);

  const maxJobs = Math.max(1, Number.parseInt(process.env.CRON_MAX_JOBS_PER_TICK || '8', 10) || 8);

  let summary;
  try {
    summary = await runDueJobs({ maxJobsPerTick: maxJobs });
  } catch (e) {
    console.error('[run_cron] runDueJobs threw:', e);
    await shutdownRunner({ label: 'run_cron' });
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const dur = Date.now() - t0;
  const memEnd = process.memoryUsage();
  console.log(`[run_cron] tick end | ran ${summary.ran} job(s) in ${fmtDuration(dur)} | ${fmtMem(memEnd)}`);

  // Close browser (if any scraper fell back to Playwright) and DB pool,
  // then hard-exit. Defends against any lingering unref'd timers / fetch
  // handles / leaked page references that would otherwise keep the process
  // alive past the crontab minute.
  await shutdownRunner({ label: 'run_cron' });

  try { await pool.end(); }
  catch (e) { console.error('[run_cron] pool.end failed:', e.message); }

  process.exit(0);
}

// Watchdog (Task A8): two-stage, mirroring services/spawn.js's
// SOFT_TIMEOUT_MS / HARD_TIMEOUT_MS child-process contract:
//   - SOFT (10 min default): the in-flight tick is almost certainly hung
//     (network deadlock, infinite scrape loop, Playwright stall). Try to
//     flush logs by closing pg pool + browser, then exit(2). The crontab
//     minute can then re-fire cleanly.
//   - HARD (12 min default, 2 min after soft): no matter what the soft
//     handler is doing, force-exit with exit(3). Defends against a soft
//     handler that itself hangs (e.g. closeBrowser() blocked on a
//     Playwright pipe that never closes).
//
// Both timers are unref'd so the watchdog itself never keeps the process
// alive past natural exit — the timers only fire if main() hasn't returned.
const SOFT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.CRON_TICK_SOFT_MS || process.env.CRON_TICK_TIMEOUT_MS || '600000', 10) || 600000
);
const HARD_MS = Math.max(SOFT_MS + 60_000, Number.parseInt(process.env.CRON_TICK_HARD_MS || '720000', 10) || 720000);

const softTimer = setTimeout(async () => {
  console.error(`[run_cron] SOFT WATCHDOG: tick exceeded ${fmtDuration(SOFT_MS)} — graceful exit`);
  try { await shutdownRunner({ label: 'run_cron-watchdog' }); } catch {}
  try { await pool.end(); } catch {}
  // Give in-flight log writes a moment, then force exit. The hard timer is
  // the real backstop — if this also hangs, HARD will fire and exit(3).
  setTimeout(() => process.exit(2), 2000).unref();
}, SOFT_MS);
softTimer.unref();

const hardTimer = setTimeout(() => {
  console.error(`[run_cron] HARD WATCHDOG: tick exceeded ${fmtDuration(HARD_MS)} — forcing exit NOW`);
  // No cleanup. The cron_runs row will be left in 'running' status — the
  // startup janitor in services/cron.js (and the inline stale-run cleanup
  // in services/runner.js) will flip it to 'failed' on the next boot or
  // the next successful tick (whichever comes first).
  process.exit(3);
}, HARD_MS);
hardTimer.unref();

main().catch(e => {
  console.error('[run_cron] FATAL:', e);
  process.exit(1);
});
