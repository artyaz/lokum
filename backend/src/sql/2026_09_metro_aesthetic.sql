-- Metro proximity + aesthetic topping columns on listings.
-- Idempotent (IF NOT EXISTS / guarded index creation) like the other migrations.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS nearest_metro JSONB;
-- {name, line, distance_m} — nearest Warsaw metro station, computed locally
-- by services/metro.js (static OSM dataset, no AI cost).

ALTER TABLE listings ADD COLUMN IF NOT EXISTS aesthetic_score SMALLINT;
-- 1-10 vision rating of how modern/clean the photos look (services/aesthetic.js).

ALTER TABLE listings ADD COLUMN IF NOT EXISTS aesthetic_rated_at TIMESTAMPTZ;
-- When the vision rating was stored (NULL = never rated).

ALTER TABLE listings ADD COLUMN IF NOT EXISTS topped BOOLEAN NOT NULL DEFAULT FALSE;
-- TRUE when the listing earned the TOP PICK chip (high aesthetic score among
-- eligible budget/metro/centrum rentals). The feed orders topped first.

CREATE INDEX IF NOT EXISTS idx_listings_topped ON listings(topped) WHERE topped = TRUE;
CREATE INDEX IF NOT EXISTS idx_listings_metro_missing ON listings(is_active) WHERE nearest_metro IS NULL AND lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_price_active ON listings(is_active, total_estimate) WHERE is_active = TRUE;
