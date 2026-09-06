-- Migration 012: link cron_runs back to the cron_jobs row that fired them.
--
-- Before Task G the cron_runs table could only be linked to a job by
-- matching (source_id, city_id, filters) — fuzzy and broken for the common
-- "all sources × all cities" job where every column is NULL. This adds a
-- nullable FK from cron_runs.cron_job_id → cron_jobs.id so the Crons UI
-- can show "last run for THIS job" with a single indexed lookup.
--
-- ON DELETE SET NULL: deleting a job doesn't erase its run history.
-- Existing rows (created before this migration) get cron_job_id = NULL,
-- which is fine — they show as "no run recorded for this job" in the UI.

ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS cron_job_id UUID
  REFERENCES cron_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs(cron_job_id, started_at DESC);
