import { Router } from 'express';
import { query, one } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import { runFetchCycle } from '../services/runner.js';
import {
  rescheduleJob,
  scheduleNextRun,
  validateCron,
  nextRunsAt
} from '../services/cron.js';

const router = Router();

// Task G — number of "next runs" the Crons UI shows as an expandable
// detail per job. Computed server-side (cron-parser is a backend dep).
const NEXT_RUNS_COUNT = 5;

// Attach last_run + next_runs to a job row. Called by both GET / and
// GET /:id so the per-job shape is consistent.
function decorateJob(job) {
  if (!job) return job;
  return {
    ...job,
    next_runs: nextRunsAt(job.schedule, NEXT_RUNS_COUNT)
  };
}

// List user's cron jobs
router.get('/', requireUser, async (req, res) => {
  try {
    // LATERAL join: one indexed lookup per job for the most recent run
    // linked to this job via cron_job_id (Task G migration 012). Falls
    // back to NULL when no run has been recorded for the job yet.
    const r = await query(
      `SELECT j.*,
              ARRAY(SELECT row_to_json(c) FROM cities c WHERE c.id = ANY(j.city_ids)) AS cities,
              ARRAY(SELECT row_to_json(s) FROM sources s WHERE s.id = ANY(j.source_ids)) AS sources,
              lr AS last_run
       FROM cron_jobs j
       LEFT JOIN LATERAL (
         SELECT id, started_at, finished_at, status, new_count,
                total_count, duration_ms, error, triggered_by
         FROM cron_runs cr
         WHERE cr.cron_job_id = j.id
         ORDER BY cr.started_at DESC
         LIMIT 1
       ) lr ON TRUE
       WHERE j.user_id = $1
       ORDER BY j.created_at DESC`,
      [req.user.id]
    );
    res.json({ jobs: r.rows.map(decorateJob) });
  } catch (e) {
    console.error('[cron_jobs] list', e);
    res.status(500).json({ error: 'list_failed' });
  }
});

// Get one
router.get('/:id', requireUser, async (req, res) => {
  try {
    const r = await one(
      `SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ job: decorateJob(r) });
  } catch (e) {
    res.status(500).json({ error: 'get_failed' });
  }
});

// Create
router.post('/', requireUser, async (req, res) => {
  try {
    const { name, schedule, source_ids, city_ids, filters, enabled } = req.body || {};
    if (!name || !schedule) return res.status(400).json({ error: 'missing_fields' });
    // Task G — strict cron-parser validation with a focused error message.
    const cronErr = validateCron(schedule);
    if (cronErr) return res.status(400).json({ error: 'bad_cron', detail: cronErr });

    const job = await one(
      `INSERT INTO cron_jobs (user_id, name, schedule, source_ids, city_ids, filters, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        name,
        schedule,
        source_ids || [],
        city_ids || [],
        JSON.stringify(filters || {}),
        enabled !== false
      ]
    );
    if (job.enabled) {
      await scheduleNextRun(job.id);
      rescheduleJob(job);
    }
    res.json({ job: decorateJob(job) });
  } catch (e) {
    console.error('[cron_jobs] create', e);
    res.status(500).json({ error: 'create_failed', detail: e.message });
  }
});

// Update
router.patch('/:id', requireUser, async (req, res) => {
  try {
    const existing = await one(
      `SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const next = {
      name: req.body.name ?? existing.name,
      schedule: req.body.schedule ?? existing.schedule,
      source_ids: req.body.source_ids ?? existing.source_ids,
      city_ids: req.body.city_ids ?? existing.city_ids,
      filters: req.body.filters ?? existing.filters,
      enabled: req.body.enabled ?? existing.enabled
    };

    // Task G — strict cron-parser validation. The previous code blindly
    // wrote whatever schedule the user typed, which silently broke
    // rescheduleJob() (cron.validate fails, the task isn't rescheduled,
    // the job appears "enabled" but never fires).
    const cronErr = validateCron(next.schedule);
    if (cronErr) return res.status(400).json({ error: 'bad_cron', detail: cronErr });

    const updated = await one(
      `UPDATE cron_jobs
       SET name=$2, schedule=$3, source_ids=$4, city_ids=$5, filters=$6, enabled=$7
       WHERE id=$1 RETURNING *`,
      [req.params.id, next.name, next.schedule,
       next.source_ids, next.city_ids,
       JSON.stringify(next.filters), next.enabled]
    );
    if (updated.enabled) {
      await scheduleNextRun(updated.id);
    } else {
      await query(`UPDATE cron_jobs SET next_run_at = NULL WHERE id = $1`, [updated.id]);
    }
    // Re-register the node-cron task in the running process so the new
    // schedule takes effect immediately (no restart required). If the
    // job is disabled, rescheduleJob cancels the existing task.
    rescheduleJob(updated);
    res.json({ job: decorateJob(updated) });
  } catch (e) {
    console.error('[cron_jobs] update', e);
    res.status(500).json({ error: 'update_failed', detail: e.message });
  }
});

// Delete
router.delete('/:id', requireUser, async (req, res) => {
  try {
    await query(`DELETE FROM cron_jobs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    // The node-cron task for this job stays in the in-memory Map until
    // the next boot — minor leak on a deleted-and-never-recreated id.
    // Acceptable for a single-user tool; rescheduleJob has the cap.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed' });
  }
});

// Run a specific cron job NOW (Task G).
//
// Differs from the existing POST /api/cron-runs/run-now (which takes
// ad-hoc source_ids/city_ids/filters in the body) and POST /test-run
// (which runs arbitrary params without persisting a cron_run.job link):
// this endpoint uses the job's stored source_ids/city_ids/filters and
// stamps the resulting cron_run row with cron_job_id so the Crons UI
// can show "last run for THIS job" immediately after the user clicks
// "Run now".
//
// Runs synchronously — the response waits for runFetchCycle to return.
// A real fetch takes 1-5 min, so the UI shows a spinner. The runner's
// in-process lock means a manual run-now also blocks a cron tick from
// overlapping, which is the desired behavior (no double-fetch).
router.post('/:id/run-now', requireUser, async (req, res) => {
  try {
    const job = await one(
      `SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!job) return res.status(404).json({ error: 'not_found' });
    const result = await runFetchCycle({
      triggeredBy: 'manual',
      sourceIds: job.source_ids || [],
      cityIds: job.city_ids || [],
      filters: job.filters || {},
      jobId: job.id
    });
    // Refresh next_run_at too — a manual run doesn't change the schedule
    // but the run itself may have side-effects the UI wants to surface.
    res.json({ run: result, job });
  } catch (e) {
    console.error('[cron_jobs] run-now', e);
    res.status(500).json({ error: 'run_failed', detail: e.message });
  }
});

// Test run (manual / on-demand)
// Body: { source_ids: [], city_ids: [], filters: {...} }
router.post('/test-run', requireUser, async (req, res) => {
  try {
    const { source_ids, city_ids, filters } = req.body || {};
    const result = await runFetchCycle({
      triggeredBy: 'test',
      sourceIds: source_ids || [],
      cityIds: city_ids || [],
      filters: filters || {}
    });
    res.json({ run: result });
  } catch (e) {
    console.error('[cron_jobs] test-run', e);
    res.status(500).json({ error: 'test_run_failed', detail: e.message });
  }
});

export default router;
