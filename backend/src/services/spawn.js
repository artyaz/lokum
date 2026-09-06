// Child-process spawner for the scraper pipeline.
//
// The Express server runs continuously (it's small). The heavy scraper
// pipeline — playwright, parsers, AI calls, all scrapers — is run as a
// SHORT-LIVED child process that EXITS when done. Between runs, idle RAM
// and CPU of the entire browser/scraper stack drops to zero.
//
// Watchdog:
//   - 10 min soft limit  → SIGTERM  (let the child clean up + flush results)
//   - 12 min hard limit  → SIGKILL  (kill -9, no chance to clean up)
//
// Zombie reaping:
//   - Always attach 'exit' + 'error' handlers in the Promise constructor.
//   - Delete from `activeChildren` on every terminal event so the Set can't
//     leak. Children whose parent has set up listeners are never zombies.
//
// Result handoff:
//   - Parent creates a temp dir + result.json path.
//   - Passes the path to the child via LOKUM_RESULT_FILE env var.
//   - Child writes a JSON snapshot of runFetchCycle's return on success.
//   - Parent reads + deletes the temp dir on exit. If the file is absent
//     (child crashed or was killed), result is null and the caller can
//     decide how to handle it (the cron_runs row will already be marked
//     'failed' or 'partial' by the child before it dies, OR remain 'running'
//     if the child was SIGKILL'd before it could update the row).

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, '..', 'run_scrape.js');

export const SOFT_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min → SIGTERM
export const HARD_TIMEOUT_MS = 12 * 60 * 1000;   // 12 min → SIGKILL

// Live children — used by graceful shutdown to SIGTERM everything.
const activeChildren = new Set();

export function getActiveChildren() {
  return new Set(activeChildren);
}

/**
 * Spawn `node src/run_scrape.js` with the given options.
 *
 * @param {Object} opts
 * @param {('cron'|'manual'|'test')} [opts.triggeredBy='manual']
 * @param {number[]} [opts.sourceIds=[]]
 * @param {number[]} [opts.cityIds=[]]
 * @param {Object}   [opts.filters={}]
 * @param {string|number} [jobId] — for log correlation
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, result: Object|null, error?: string }>}
 */
export function spawnScrape({ triggeredBy = 'manual', sourceIds = [], cityIds = [], filters = {} } = {}, jobId = null) {
  return new Promise((resolve) => {
    let tmpDir = null;
    let resultFile = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokum-run-'));
      resultFile = path.join(tmpDir, 'result.json');
    } catch (e) {
      // Without a result file we can still run the child — the parent just
      // won't get the structured result back.
      resultFile = null;
    }

    const args = [RUNNER];
    if (triggeredBy && triggeredBy !== 'manual') {
      args.push('--triggered-by', triggeredBy);
    }
    if (sourceIds && sourceIds.length) {
      args.push(sourceIds.map(String).join(','));
    }
    if (cityIds && cityIds.length) {
      args.push('--cities', cityIds.map(String).join(','));
    }
    if (filters && typeof filters === 'object' && Object.keys(filters).length) {
      args.push('--filters', JSON.stringify(filters));
    }

    const env = { ...process.env };
    if (resultFile) env.LOKUM_RESULT_FILE = resultFile;
    // Tighten the child's runtime GC so transient scraper buffers don't linger.
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --expose-gc';

    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true
    });
    activeChildren.add(child);

    let stdoutBuf = '';
    let stderrBuf = '';
    let softTimer = null;
    let hardTimer = null;
    let resolved = false;

    // Bound the stdout/stderr buffers so a chatty child can't OOM the parent.
    const MAX_BUF = 2 * 1024 * 1024;  // 2 MiB each

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      activeChildren.delete(child);
      // Clean up the temp dir + result file
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      // Stream to parent's stdout for live visibility
      process.stdout.write(chunk);
      if (stdoutBuf.length > MAX_BUF) {
        stdoutBuf = stdoutBuf.slice(-MAX_BUF);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      process.stderr.write(chunk);
      if (stderrBuf.length > MAX_BUF) {
        stderrBuf = stderrBuf.slice(-MAX_BUF);
      }
    });

    softTimer = setTimeout(() => {
      console.warn(`[spawn] child ${child.pid} exceeded ${SOFT_TIMEOUT_MS}ms — SIGTERM${jobId != null ? ` (job ${jobId})` : ''}`);
      try { child.kill('SIGTERM'); } catch {}
    }, SOFT_TIMEOUT_MS);

    hardTimer = setTimeout(() => {
      console.error(`[spawn] child ${child.pid} exceeded ${HARD_TIMEOUT_MS}ms — SIGKILL${jobId != null ? ` (job ${jobId})` : ''}`);
      try { child.kill('SIGKILL'); } catch {}
    }, HARD_TIMEOUT_MS);

    child.on('error', (err) => {
      console.error(`[spawn] child error:`, err.message);
      finish({ code: -1, signal: null, stdout: stdoutBuf, stderr: stderrBuf, result: null, error: err.message });
    });

    child.on('exit', (code, signal) => {
      // Try to read the result file the child should have written
      let result = null;
      if (resultFile) {
        try {
          const raw = fs.readFileSync(resultFile, 'utf8');
          result = JSON.parse(raw);
        } catch {
          // File missing or unparseable — child crashed/killed before writing
          result = null;
        }
      }
      finish({ code, signal, stdout: stdoutBuf, stderr: stderrBuf, result });
    });
  });
}

/**
 * Kill every active scraper child. Used by the parent's SIGTERM/SIGINT handler.
 * @param {string} signal — 'SIGTERM' (default) or 'SIGKILL'
 */
export function killAllChildren(signal = 'SIGTERM') {
  for (const child of activeChildren) {
    try { child.kill(signal); } catch {}
  }
}
