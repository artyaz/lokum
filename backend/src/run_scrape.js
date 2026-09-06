// CLI: run a single fetch cycle.
// Usage: node src/run_scrape.js [source_ids...] [--cities city_ids...] [--filters '{"maxPrice":5000}'] [--triggered-by cron|manual|test]
//
// Memory/CPU contract (Task A1):
//   - The run is one-shot: after runFetchCycle resolves, we explicitly close
//     the browser singleton (Playwright's chromium child process + IPC pipe
//     otherwise keeps the Node event loop alive for IDLE_CLOSE_MS seconds),
//     then end the pg pool, then process.exit(0).
//   - process.memoryUsage() is logged at start and end of the run so any
//     leak between runs is visible in logs.
//
// Integration with src/services/spawn.js (Task A2):
//   - If LOKUM_RESULT_FILE is set, the run writes a JSON snapshot of the
//     runFetchCycle return value to that path before exit, so the parent
//     Express process can pick up structured results without an IPC round
//     trip.
//   - --triggered-by overrides the default 'manual' trigger. spawnScrape()
//     passes this when invoking the child on behalf of a cron job.

import 'dotenv/config';
import fs from 'fs';
import { pool } from './db.js';
import { runFetchCycle, shutdownRunner } from './services/runner.js';

function fmtMem(m) {
  return `rss=${Math.round(m.rss/1024/1024)}MB heap=${Math.round(m.heapUsed/1024/1024)}MB ext=${Math.round(m.external/1024/1024)}MB`;
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceIds = [];
  const cityIds = [];
  let filters = {};
  let triggeredBy = 'manual';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^\d+$/.test(a)) sourceIds.push(parseInt(a));
    else if (a === '--cities' || a === '--city') {
      const next = argv[++i];
      if (next) next.split(',').forEach(s => cityIds.push(parseInt(s)));
    }
    else if (a === '--filters' || a === '--filter') {
      try { filters = JSON.parse(argv[++i] || '{}'); } catch {}
    }
    else if (a === '--max-price') filters.maxPrice = parseInt(argv[++i]);
    else if (a === '--min-rooms') filters.minRooms = parseInt(argv[++i]);
    else if (a === '--max-rooms') filters.maxRooms = parseInt(argv[++i]);
    else if (a === '--triggered-by') {
      const v = argv[++i];
      if (v === 'cron' || v === 'manual' || v === 'test') triggeredBy = v;
    }
  }

  const memStart = process.memoryUsage();
  console.log('[run_scrape] starting — triggeredBy:', triggeredBy,
              'sources:', sourceIds.length ? sourceIds : 'ALL',
              'cities:', cityIds.length ? cityIds : 'ALL',
              'filters:', filters,
              '|', fmtMem(memStart));

  let result;
  try {
    result = await runFetchCycle({
      triggeredBy,
      sourceIds, cityIds, filters
    });
  } catch (e) {
    console.error('[run_scrape] runFetchCycle threw:', e);
    await shutdownRunner({ label: 'run_scrape' });
    await pool.end().catch(() => {});
    process.exit(1);
  }

  console.log('[run_scrape] done — status:', result.status,
              'new:', result.new_count, 'total:', result.total_count,
              'duration_ms:', result.duration_ms);
  if (result.error) console.error('[run_scrape] error:', result.error);

  // print per-source stats
  for (const sid of Object.keys(result.perSource || {})) {
    const s = result.perSource[sid];
    const src = result.sources.find(x => x.id == sid);
    console.log(`  ${src?.slug || sid}: ${s.new} new / ${s.total} total` +
                (s.error ? ` (error: ${s.error})` : ''));
  }

  // Hand structured result back to the parent process via the agreed temp
  // file (see services/spawn.js). Safe to skip when not running under spawn.
  if (process.env.LOKUM_RESULT_FILE) {
    try {
      fs.writeFileSync(
        process.env.LOKUM_RESULT_FILE,
        JSON.stringify({
          id: result.id,
          status: result.status,
          new_count: result.new_count,
          total_count: result.total_count,
          duration_ms: result.duration_ms,
          error: result.error || null,
          started_at: result.started_at,
          finished_at: result.finished_at,
          perSource: result.perSource
        })
      );
    } catch (e) {
      console.error('[run_scrape] write LOKUM_RESULT_FILE failed:', e.message);
    }
  }

  // Close everything the run may have opened before exiting.
  // If we skip closeBrowser, the chromium child process keeps the loop alive
  // for IDLE_CLOSE_MS seconds (up to 60s in always-on, 5s in LOKUM_ONESHOT=1).
  await shutdownRunner({ label: 'run_scrape' });

  try { await pool.end(); }
  catch (e) { console.error('[run_scrape] pool.end failed:', e.message); }

  // Hard exit — defends against any remaining unref'd timers / pending
  // fetch handles that would otherwise hold the process open.
  process.exit(0);
}

main().catch(e => {
  console.error('[run_scrape] FAILED:', e);
  process.exit(1);
});

