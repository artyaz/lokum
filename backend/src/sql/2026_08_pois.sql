-- 2026_08_pois: Points-of-Interest cache + starred-POI persistence (Task F).
--
-- Background:
--   The previous "POI" pipeline was a regex keyword matcher over the
--   listing's own description (services/scrapers/olx.js#extractConveniences,
--   keywords: silownia/gym/centrum handlowe/biedronka/etc.). That approach
--   has no concept of distance — every chip just said "Gym nearby" or
--   "Shopping mall" with no radius, no name, no coordinates, and the data
--   never persisted beyond the listing row. So a listing whose description
--   happened to mention "Biedronka" got a chip; the very same Biedronka
--   half a block away from a different listing got nothing.
--
--   Task F replaces that with real geographic POI fetching via the Google
--   Maps Places API (Nearby Search), cached at a ~1m grid (5-decimal lat/lng
--   rounded) for 30 days. The cache is shared across ALL listings inside
--   that ~1m cell — so an apartment building at 52.22972,21.01220 fetched
--   once covers every other listing within ~1m of those rounded coords.
--   Falls back to the Overpass API (OpenStreetMap) if the Google quota
--   is exceeded or no API key is configured.
--
--   Starred POIs are persisted in a separate table keyed by Google
--   `place_id` (NULL for Overpass-sourced entries) with a name+coords
--   fallback matcher. user_id is NULLABLE so single-user deployments can
--   operate without auth; multi-user deployments set user_id per row.
--
-- Idempotent: every statement uses CREATE TABLE IF NOT EXISTS / CREATE
-- INDEX IF NOT EXISTS, so this migration is safe to re-run on every deploy.

-- 1. POI cache: shared Google/Overpass results keyed by rounded coords.
--    PRIMARY KEY (lat, lng, type) so a single listing-fits-in-cell lookup
--    hits the cache directly. 5-decimal precision (~1.1m at Warsaw latitude)
--    is the rounding applied in services/pois.js#round5 BEFORE the write,
--    so the PK never collides for distinct ~1m cells.
CREATE TABLE IF NOT EXISTS poi_cache (
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  type         TEXT NOT NULL,                 -- 'restaurant' | 'store' | 'gym' | 'shopping_mall' | 'park'
  places_json  JSONB NOT NULL,                -- [{name, type, lat, lng, place_id, rating, address}]
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lat, lng, type)
);

-- The PK already gives us (lat,lng,type) lookups; this index is belt-and-
-- braces so the EXPLAIN plan stays predictable on Postgres 14+ even when
-- the planner decides not to use the PK for a 2-column filter.
CREATE INDEX IF NOT EXISTS idx_poi_cache_latlng
  ON poi_cache(lat, lng);

-- 2. Starred POIs: the user's "favorite" POIs that get a filled star
--    everywhere they appear (card + detail). Matched back to fresh fetch
--    results in services/pois.js#matchStarred by `place_id` (exact, when
--    Google-sourced) OR name+coords within 50m (Haversine) when the POI
--    was Overpass-sourced (no place_id).
CREATE TABLE IF NOT EXISTS starred_pois (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = single-user mode
  place_id    TEXT,                          -- Google Place ID; NULL for Overpass
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (user_id, place_id) uniqueness: one star per place per user. NULL
-- place_id is allowed (Overpass) — we use a partial index to enforce
-- uniqueness only for Google-sourced stars so two taps on the same
-- place_id can't double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_starred_pois_user_place
  ON starred_pois(user_id, place_id)
  WHERE place_id IS NOT NULL;

-- (user_id, name, lat, lng) uniqueness: same rule for Overpass-sourced
-- entries (no place_id). 5-decimal lat/lng rounding keeps the matcher
-- stable across refetches that nudge coords by <1m.
CREATE UNIQUE INDEX IF NOT EXISTS idx_starred_pois_user_namecoords
  ON starred_pois(user_id, name, lat, lng)
  WHERE place_id IS NULL;

-- Fast lookup for "show me all starred POIs for the active user" —
-- powers GET /api/pois/starred and the starred-state join in
-- services/pois.js#matchStarred. Partial index keeps it small: only
-- rows where user_id is NULL (single-user mode) — the typical deploy.
CREATE INDEX IF NOT EXISTS idx_starred_pois_global
  ON starred_pois(lat, lng)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_starred_pois_user
  ON starred_pois(user_id)
  WHERE user_id IS NOT NULL;
