// Cron scheduler using node-cron.
// - Loads all enabled cron_jobs from DB on boot
// - Schedules each via node-cron
// - Provides rescheduleJob(job) for create/update
//
// Two execution modes:
//   1. ALWAYS-ON (default, src/index.js): initScheduler() registers node-cron
//      tasks inside the Express server process. Idle CPU stays low (node-cron
//      uses a single setTimeout-per-task), but the process never exits.
//   2. ONESHOT (src/run_cron.js, system crontab): no node-cron timers. The
//      process boots, runs all jobs whose next_run_at <= NOW(), updates
//      next_run_at in the DB, then exits. Between runs the OS reclaims all
//      RAM/CPU — true ~0 idle.

import cron from 'node-cron';
import cronParser from 'cron-parser';
import { query, one } from '../db.js';
import { runFetchCycle } from './runner.js';

const scheduledTasks = new Map(); // jobId -> { task, nextAt }
// Hard cap to prevent runaway growth if some path forgets to delete a task.
// The DB is the source of truth; this Map should never exceed job count.
const MAX_SCHEDULED_TASKS = 256;

// Compute next run time from a 5-field cron expression.
// tz defaults to Europe/Warsaw (matches our scheduling tz).
export function nextRunAt(cronExpr, tz = 'Europe/Warsaw') {
  if (!cron.validate(cronExpr)) return null;
  try {
    const interval = cronParser.parseExpression(cronExpr, { tz });
    return interval.next().toDate();
  } catch (e) {
    console.warn('[cron] nextRunAt failed for', cronExpr, e.message);
    return null;
  }
}

// Task G — return the next `count` fire-times of a cron expression so the
// Crons UI can show "next 5 runs" as an expandable detail. Returns an
// empty array when the expression is invalid (the route layer surfaces a
// 400 before reaching here, this is the defensive fallback).
export function nextRunsAt(cronExpr, count = 5, tz = 'Europe/Warsaw') {
  if (!cron.validate(cronExpr)) return [];
  try {
    const interval = cronParser.parseExpression(cronExpr, { tz });
    const out = [];
    for (let i = 0; i < count; i++) out.push(interval.next().toDate());
    return out;
  } catch (e) {
    console.warn('[cron] nextRunsAt failed for', cronExpr, e.message);
    return [];
  }
}

// Strict cron-parser validation. `cron.validate` is permissive (accepts
// 6-field and macros); the route layer wants a single, focused error
// message so users editing the schedule in the UI know exactly what's
// wrong. Returns null if valid, or a human-readable reason if not.
export function validateCron(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return 'schedule is required';
  const parts = String(cronExpr).trim().split(/\s+/);
  if (parts.length !== 5) return 'cron must have exactly 5 fields (min hour dom mon dow)';
  if (!cron.validate(cronExpr)) return `invalid cron expression: "${cronExpr}"`;
  try {
    cronParser.parseExpression(cronExpr, { tz: 'Europe/Warsaw' });
    return null;
  } catch (e) {
    return e.message || 'invalid cron expression';
  }
}

// Persist next_run_at based on cron expression
export async function scheduleNextRun(jobId) {
  const job = await one(`SELECT schedule FROM cron_jobs WHERE id = $1`, [jobId]);
  if (!job) return null;
  const next = nextRunAt(job.schedule);
  if (next) {
    await query(`UPDATE cron_jobs SET next_run_at = $2 WHERE id = $1`, [jobId, next]);
  } else {
    await query(`UPDATE cron_jobs SET next_run_at = NULL WHERE id = $1`, [jobId]);
  }
  return next;
}

// Schedule a job to actually fire when its cron expression says so
export function rescheduleJob(job) {
  // cancel existing task
  const existing = scheduledTasks.get(job.id);
  if (existing?.task) existing.task.stop();
  if (!job.enabled) {
    scheduledTasks.delete(job.id);
    return;
  }
  if (!cron.validate(job.schedule)) {
    console.warn('[cron] invalid schedule', job.schedule, 'for job', job.id);
    return;
  }
  const task = cron.schedule(job.schedule, async () => {
    console.log(`[cron] firing job ${job.id} (${job.name})`);
    try {
      // Task G — stamp the cron_run row with this job's id so the Crons UI
      // can show "last run for THIS job" without fuzzy source/city matching.
      const result = await runFetchCycle({
        triggeredBy: 'cron',
        sourceIds: job.source_ids || [],
        cityIds: job.city_ids || [],
        filters: job.filters || {},
        jobId: job.id
      });
      console.log(`[cron] job ${job.id} done — ${result.new_count} new of ${result.total_count}`);
    } catch (e) {
      console.error(`[cron] job ${job.id} error:`, e.message);
    } finally {
      // schedule next
      await scheduleNextRun(job.id);
    }
  }, { timezone: 'Europe/Warsaw' });
  // Defensive cap: if some bug causes the Map to balloon, drop oldest.
  // This should never happen in normal operation (rescheduleJob stops the
  // existing task for the same jobId before inserting a new one).
  if (scheduledTasks.size >= MAX_SCHEDULED_TASKS) {
    const firstKey = scheduledTasks.keys().next().value;
    const t = scheduledTasks.get(firstKey);
    t?.task?.stop?.();
    scheduledTasks.delete(firstKey);
  }
  scheduledTasks.set(job.id, { task, job });
}

// On boot, load all enabled jobs and schedule them.
// There is NO built-in default cron — only user-defined cron_jobs fire.
// If the user has no jobs, nothing runs automatically.
//
// Startup janitor (Task A8, recommended by B8):
// Any 'running' rows from a previous boot are stale — the process died
// before completing them, otherwise they'd be 'success'/'partial'/'failed'
// by now. Flip them to 'failed' so the run-concurrency lock in
// services/runner.js doesn't block the first new tick on a dead row.
export async function initScheduler() {
  try {
    const janitor = await query(
      `UPDATE cron_runs cr
       SET status = 'failed',
           error = COALESCE(error, 'stale: process restarted while running'),
           finished_at = NOW(),
           duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
           new_count = (SELECT count(*) FROM cron_run_listings crl WHERE crl.cron_run_id = cr.id AND crl.was_new),
           total_count = (SELECT count(*) FROM cron_run_listings crl WHERE crl.cron_run_id = cr.id)
       WHERE cr.status = 'running'`
    );
    if (janitor.rowCount) {
      console.log(`[cron] startup janitor: marked ${janitor.rowCount} stale 'running' row(s) as 'failed'`);
    }
  } catch (e) {
    console.error('[cron] startup janitor failed:', e.message);
  }

  const r = await query(`SELECT * FROM cron_jobs WHERE enabled = TRUE`);
  for (const job of r.rows) {
    rescheduleJob(job);
    await scheduleNextRun(job.id);
  }
  console.log(`[cron] scheduled ${r.rows.length} user job(s)`);
}

// ONESHOT entry point: find all enabled jobs whose next_run_at is due
// (or not yet computed) and run them sequentially. Updates next_run_at
// for each. Designed to be invoked by a system crontab line every minute:
//
//   * * * * * cd /opt/lokum/backend && LOKUM_ONESHOT=1 node src/run_cron.js >> /var/log/lokum-cron.log 2>&1
//
// In oneshot mode the process boots, runs the due jobs, then exits — so
// idle RAM/CPU between runs is genuinely zero (no node-cron timers, no
// Express server, no held browser).
//
// `maxJobsPerTick` caps work per invocation so a single crontab minute
// can't accidentally run for an hour.
export async function runDueJobs({ maxJobsPerTick = 8, now = new Date() } = {}) {
  const due = await query(
    `SELECT * FROM cron_jobs
     WHERE enabled = TRUE
       AND (next_run_at IS NULL OR next_run_at <= $1)
     ORDER BY COALESCE(next_run_at, '1970-01-01') ASC
     LIMIT $2`,
    [now, maxJobsPerTick]
  );

  if (!due.rows.length) {
    console.log('[cron] no due jobs');
    return { ran: 0, results: [] };
  }

  console.log(`[cron] oneshot: ${due.rows.length} job(s) due`);
  const results = [];
  for (const job of due.rows) {
    const t0 = Date.now();
    const memBefore = process.memoryUsage();
    console.log(`[cron] firing job ${job.id} (${job.name}) | rss=${Math.round(memBefore.rss/1024/1024)}MB heap=${Math.round(memBefore.heapUsed/1024/1024)}MB`);
    try {
      // Task G — stamp cron_run with job.id (same as rescheduleJob above).
      const result = await runFetchCycle({
        triggeredBy: 'cron',
        sourceIds: job.source_ids || [],
        cityIds: job.city_ids || [],
        filters: job.filters || {},
        jobId: job.id
      });
      const memAfter = process.memoryUsage();
      console.log(`[cron] job ${job.id} done — ${result.new_count} new of ${result.total_count} in ${Date.now()-t0}ms | rss=${Math.round(memAfter.rss/1024/1024)}MB heap=${Math.round(memAfter.heapUsed/1024/1024)}MB`);
      results.push({ jobId: job.id, status: 'ok', new_count: result.new_count, total_count: result.total_count, ms: Date.now() - t0 });
    } catch (e) {
      console.error(`[cron] job ${job.id} error:`, e.message);
      results.push({ jobId: job.id, status: 'error', error: e.message, ms: Date.now() - t0 });
    } finally {
      // Always advance next_run_at so a failed job doesn't re-fire every tick.
      await scheduleNextRun(job.id);
    }
  }
  return { ran: due.rows.length, results };
}
