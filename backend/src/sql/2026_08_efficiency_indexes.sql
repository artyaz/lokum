-- 2026_08_efficiency_indexes: missing indexes for the cron hot path + dedupe.
--
-- Background:
--   The schema.sql indexes cover the obvious read paths (city, source, price,
--   first_seen_at) but were written before the dedupe pipeline (B7's
--   photo_phash / duplicate_of_id columns, A6's pHash worker, A2's batched
--   image/convenience INSERTs) and before the run-concurrency lock (A8) /
--   startup-janitor pattern were added. Several hot queries now hit indexes
--   that don't exist:
--
--     - listings.posted_at                  → ORDER BY l.posted_at DESC NULLS LAST
--                                              (the interleave ordering on
--                                              /api/listings)
--     - listings.external_id                → scraper-side
--                                              "WHERE source_id = $1 AND
--                                               external_id = ANY($2::text[])"
--                                              dedupe-against-existing checks
--     - listings(city_id, ...) WHERE is_active = TRUE
--                                          → dedupe candidate scan + the
--                                            /api/listings feed filter
--     - listing_images.url                  → dedupe.js "WHERE url = ANY(...)"
--     - cron_runs(started_at) WHERE status = 'running'
--                                          → run-concurrency lock check
--     - cron_runs(started_at) WHERE status IN ('success','partial')
--                                     AND triggered_by IN ('cron','manual')
--                                          → getSinceTime + /api/listings/runs
--
-- Idempotent: every statement uses CREATE INDEX IF NOT EXISTS, so this
-- migration is safe to re-run on every deploy. Concurrent index builds
-- (CONCURRENTLY) would avoid locking the table during the build, but Neon's
-- pooled endpoint doesn't allow CONCURRENTLY from a connection that's also
-- holding a transaction open; the affected tables are small (<1M rows) so a
-- plain CREATE INDEX is fast and the brief lock is acceptable.
--
-- A3 also reviewed the columns commonly filtered on (per the brief) and
-- lists them here with their status so the next reader knows what's
-- already covered:
--
--   region              → No `region` column on listings; closest is
--                          `district` (not filtered in SQL — region is
--                          applied in JS via pointInPolygon on lat/lng).
--                          `regions` table already indexes (city_id, user_id).
--   price               → idx_listings_price (existing, schema.sql)
--   scraped_at          → No `scraped_at` column on listings; the equivalent
--                          is `first_seen_at` (idx_listings_first_seen, existing)
--                          or `last_seen_at` (NOT indexed — but only updated
--                          by row-id, no WHERE on it). Left unindexed.
--   dedupe_key          → The (source_id, external_id) UNIQUE constraint IS
--                          the dedupe key (covers persistListing UPSERT + the
--                          "did we already see this external_id" checks).
--                          Already implicitly indexed by the UNIQUE constraint.
--   photo_phash         → idx_listings_photo_phash (existing, 2026_08_dedupe_phash.sql)
--   source_id           → idx_listings_source (existing, schema.sql)
--   external_id         → NEW: idx_listings_external_id (see below). The
--                          UNIQUE (source_id, external_id) index only helps
--                          queries that filter on source_id first; the scraper
--                          dedupe checks use `external_id = ANY(...)` which
--                          can't use the composite index efficiently.
--   duplicate_of_id     → idx_listings_duplicate_of (existing, 2026_08_dedupe_phash.sql)
--   listings.created_at → No such column on listings (created_at exists on
--                          users / passkeys / sessions / facebook_groups /
--                          facebook_cookie_sessions / cron_jobs / share_tokens
--                          / listing_duplicates / starred_pois / regions, but
--                          NOT on listings). The closest concept on listings
--                          is `first_seen_at` (already indexed).
--   listings.first_seen_at → idx_listings_first_seen (existing, schema.sql)
--   listings.posted_at  → NEW: idx_listings_posted_at (see below).

-- 1. listings.posted_at — used in the /api/listings interleave ordering
--    (ROW_NUMBER() OVER (PARTITION BY l.source_id ORDER BY l.first_seen_at DESC,
--     l.posted_at DESC NULLS LAST)). NULLS are common (gratka/morizon/adresowo
--    don't always have a posted date) so we don't use a partial index here.
CREATE INDEX IF NOT EXISTS idx_listings_posted_at
  ON listings(posted_at DESC);

-- 2. listings.external_id — covers the per-scraper "have I already seen these
--    external_ids?" dedupe check that runs after each fetchCity. The existing
--    UNIQUE (source_id, external_id) index can't serve `external_id = ANY($1)`
--    efficiently (source_id isn't the leading column of the filter). Small
--    partial-ish win: most listings share external_ids only across the same
--    source, but the index also helps backfill/admin scripts that look up a
--    listing by external_id alone.
CREATE INDEX IF NOT EXISTS idx_listings_external_id
  ON listings(external_id);

-- 3. listings(city_id) WHERE is_active = TRUE — the dedupe candidate scan
--    (dedupe.js#dedupeForListings line ~615) and the /api/listings feed both
--    filter `city_id = $1 AND is_active = TRUE`. A partial index is much
--    smaller than the full idx_listings_city (most queries want active only)
--    and stays warm in cache between runs.
CREATE INDEX IF NOT EXISTS idx_listings_city_active
  ON listings(city_id)
  WHERE is_active = TRUE;

-- 4. listings(city_id, rooms, price) WHERE is_active = TRUE — the dedupe
--    candidate scan's WHERE clause is literally
--      `l.is_active = TRUE AND l.city_id = $1 AND l.id != $2
--       AND l.source_id != $3
--       AND l.rooms IS NOT DISTINCT FROM $4
--       AND l.price BETWEEN $5 AND $6`
--    This composite partial index lets Postgres nail it in one index scan
--    per listing instead of seq-scanning the city's active rows for each of
--    the N new listings. For a 1 000-listing busy Warsaw run with ~50 new
--    OLX listings, this is ~50 candidate scans × ~5ms saved each = ~250ms
--    per run; multiplied across all cron ticks in a day it adds up.
CREATE INDEX IF NOT EXISTS idx_listings_city_active_rooms_price
  ON listings(city_id, rooms, price)
  WHERE is_active = TRUE;

-- 5. listing_images(url) — dedupe.js#dedupeForListings image-candidate pass
--    (line ~627) runs
--      `SELECT DISTINCT listing_id FROM listing_images
--       WHERE url = ANY($1::text[]) AND listing_id != $2`
--    The existing idx_images_listing(listing_id, position) is the wrong
--    shape for url-first lookups, so Postgres seq-scans listing_images
--    (which can grow to ~20× the listings count = ~20k rows for a 1k-listing
--    busy state). This index makes the url lookup an index scan.
CREATE INDEX IF NOT EXISTS idx_listing_images_url
  ON listing_images(url);

-- 6. cron_runs(started_at DESC) WHERE status = 'running' — the
--    run-concurrency lock in runner.js#runFetchCycle does
--      `SELECT id, started_at FROM cron_runs
--       WHERE status = 'running'
--       ORDER BY started_at DESC LIMIT 1`
--    on every fetch cycle. With no index, Postgres seq-scans cron_runs
--    (which grows ~6 rows/day, so the impact is small today but grows
--    unbounded). Partial index keeps it ~1 row in steady state.
CREATE INDEX IF NOT EXISTS idx_cron_runs_running
  ON cron_runs(started_at DESC)
  WHERE status = 'running';

-- 7. cron_runs(started_at DESC) WHERE status IN ('success','partial')
--    AND triggered_by IN ('cron','manual') — covers:
--      - runner.js#getSinceTime (latest real run's started_at)
--      - runner.js#getPrevRunListingIds (OFFSET 1)
--      - listings.js#/runs (the date dropdown)
--      - listings.js#baseSql EXISTS subquery (the is_new computation)
--    All of these filter on status+triggered_by first, then sort by
--    started_at DESC. Partial index keeps it small and avoids scanning
--    'test' / 'failed' / 'running' rows.
CREATE INDEX IF NOT EXISTS idx_cron_runs_real_started
  ON cron_runs(started_at DESC)
  WHERE status IN ('success','partial')
    AND triggered_by IN ('cron','manual');

-- 8. cron_runs(triggered_by, started_at DESC) — covers the listings.js
--    /runs query `WHERE cr.triggered_by IN ('cron','manual') ORDER BY
--    cr.started_at DESC LIMIT $1`. The partial index #7 above could
--    serve this too (it filters the same status set), but #7 also
--    filters status which the /runs query doesn't. A small non-partial
--    two-column index is a safer general fallback for any future
--    "list runs by trigger type" query.
CREATE INDEX IF NOT EXISTS idx_cron_runs_triggered_started
  ON cron_runs(triggered_by, started_at DESC);
