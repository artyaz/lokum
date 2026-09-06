-- 2026_08_poll_watermarks: per-(source, city) change-detection watermark
-- for the always-on fetcher (Task I, design H4).
--
-- Background:
--   The always-on watcher loop (services/alwaysOn.js) probes page 1 of each
--   source's search feed every 75-180s (per-source intervals from H4). To
--   avoid re-enqueuing listings that were already seen, the watcher keeps a
--   per-(source, city) watermark of:
--     - page1_hash        — sha256 of the sorted set of listing IDs returned
--                           on page 1. Sorted (not insertion-ordered) so that
--                           OLX's promoted-ad rotation within page 1 doesn't
--                           flip the hash without a real new listing (H2-T3).
--     - last_seen_ids     — capped (~500) ring of the newest externalIds the
--                           watcher has enqueued. Used for the "walk from
--                           top until first known ID" short-circuit (H2-T4).
--     - consecutive_empty_polls — how many ticks in a row returned the same
--                           hash. Used by the adaptive backoff (T2, future).
--     - last_changed_at  — when the hash last changed (i.e. when a new
--                           listing was last detected on this source/city).
--                           Drives the "X min ago" latency dashboard.
--     - last_poll_at     — when the watcher last ticked for this source/city.
--                           Lets us detect a dead watcher (last_poll_at <
--                           now - 3 * interval).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, so safe
-- to re-run on every deploy.
--
-- Note: the watermark table is per (source_id, city_id) — one row per
-- (source, city) combo the watcher polls. With 6 always-on sources × 5
-- cities = 30 rows max. Trivially small. The 'consecutive_empty_polls'
-- counter is reset to 0 on any successful tick that finds new listings;
-- it's only bumped on a no-change tick.

CREATE TABLE IF NOT EXISTS poll_watermarks (
  source_id             SMALLINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  city_id               SMALLINT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  page1_hash            TEXT,
  last_seen_ids         TEXT[]   NOT NULL DEFAULT '{}',
  consecutive_empty_polls INTEGER NOT NULL DEFAULT 0,
  consecutive_errors    INTEGER  NOT NULL DEFAULT 0,
  paused_until          TIMESTAMPTZ,
  last_changed_at       TIMESTAMPTZ,
  last_poll_at          TIMESTAMPTZ,
  PRIMARY KEY (source_id, city_id)
);

-- Index for the watcher's "what's due next?" priority-queue lookup. Partial
-- (only enabled sources) keeps it ~6 rows × 5 cities = 30 in steady state.
CREATE INDEX IF NOT EXISTS idx_poll_watermarks_next_due
  ON poll_watermarks(last_poll_at)
  WHERE paused_until IS NULL;
