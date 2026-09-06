-- Lokum — rental listings aggregator
-- Schema for Neon Postgres

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============ USERS / AUTH ============
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  password_hash TEXT,                       -- nullable for passkey-only accounts
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkeys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    BYTEA NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',
  device_type   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============ STATIC LOOKUPS ============
CREATE TABLE IF NOT EXISTS cities (
  id    SMALLINT PRIMARY KEY,
  name  TEXT NOT NULL,                       -- "Warsaw"
  name_pl TEXT NOT NULL,                     -- "Warszawa"
  slug  TEXT NOT NULL UNIQUE,
  lat   DOUBLE PRECISION NOT NULL,
  lng   DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id    SMALLINT PRIMARY KEY,
  name  TEXT NOT NULL,                       -- "OLX", "Otodom"
  slug  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,                       -- hex color for badges
  base_url TEXT NOT NULL
);

-- ============ LISTINGS ============
CREATE TABLE IF NOT EXISTS listings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       SMALLINT NOT NULL REFERENCES sources(id),
  external_id     TEXT NOT NULL,             -- id on the source site
  city_id         SMALLINT NOT NULL REFERENCES cities(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',  -- full ad description (Polish)
  price           INTEGER NOT NULL,          -- monthly rent in PLN
  currency        TEXT NOT NULL DEFAULT 'PLN',
  rooms           SMALLINT,
  area            REAL,                       -- m²
  floor           TEXT,                       -- "3/5"
  district        TEXT,
  street          TEXT,
  address        TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  url             TEXT NOT NULL,
  posted_at       TIMESTAMPTZ,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when we first scraped it
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last time it was still up
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,        -- still in feed
  raw             JSONB,                     -- raw payload from scraper
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city_id);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON listings(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source_id);

CREATE TABLE IF NOT EXISTS listing_images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  position    SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_listing ON listing_images(listing_id, position);

CREATE TABLE IF NOT EXISTS listing_conveniences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- 'park','gym','mall','market','transport','school'
  label       TEXT NOT NULL                  -- "Łazienki Park · 250 m"
);
CREATE INDEX IF NOT EXISTS idx_conv_listing ON listing_conveniences(listing_id);

-- ============ CRON RUNS (fetch cycles) ============
CREATE TABLE IF NOT EXISTS cron_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running',  -- 'running','success','failed','partial','skipped'
  source_id     SMALLINT REFERENCES sources(id),  -- NULL = all sources
  city_id       SMALLINT REFERENCES cities(id),   -- NULL = all cities
  -- Task G: nullable FK back to the cron_jobs row that fired this run.
  -- NULL for runs triggered ad-hoc (manual run-now with custom source
  -- list, test-run, always-on fetcher ticks). ON DELETE SET NULL keeps
  -- run history when a job is deleted.
  new_count     INTEGER NOT NULL DEFAULT 0,
  total_count   INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  error         TEXT,
  triggered_by  TEXT NOT NULL DEFAULT 'cron',     -- 'cron' | 'manual' | 'test'
  filters       JSONB                            -- applied filters snapshot
);

CREATE TABLE IF NOT EXISTS cron_run_listings (
  cron_run_id  UUID NOT NULL REFERENCES cron_runs(id) ON DELETE CASCADE,
  listing_id   UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  was_new      BOOLEAN NOT NULL DEFAULT FALSE,    -- first time we saw this listing
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cron_run_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_crl_run ON cron_run_listings(cron_run_id);
CREATE INDEX IF NOT EXISTS idx_crl_listing ON cron_run_listings(listing_id);
CREATE INDEX IF NOT EXISTS idx_crl_was_new ON cron_run_listings(cron_run_id, was_new);

-- ============ CRON JOBS (user-defined scheduled fetches) ============
CREATE TABLE IF NOT EXISTS cron_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  schedule      TEXT NOT NULL,                -- cron expression e.g. "0 6,18 * * *"
  source_ids    SMALLINT[] NOT NULL DEFAULT '{}',
  city_ids      SMALLINT[] NOT NULL DEFAULT '{}',
  filters       JSONB NOT NULL DEFAULT '{}',  -- {maxPrice, rooms, etc}
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled, next_run_at);
ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS cron_job_id UUID REFERENCES cron_jobs(id) ON DELETE SET NULL;

-- ============ SAVED LISTINGS ============
CREATE TABLE IF NOT EXISTS saved_listings (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id   UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id)
);

-- ============ REGIONS (user-drawn map polygons) ============
-- A region is a polygon drawn by the user on a city map. Listings whose
-- lat/lng falls inside the polygon get the region name appended to their
-- conveniences list (type='region').
CREATE TABLE IF NOT EXISTS regions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id     SMALLINT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#C15F3C',
  polygon     JSONB NOT NULL,   -- GeoJSON Polygon: { type:"Polygon", coordinates:[[[lng,lat],...]] }
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_regions_city ON regions(city_id);
CREATE INDEX IF NOT EXISTS idx_regions_user ON regions(user_id);

-- ============ SHARE TOKENS (public listing links) ============
-- A share token lets anyone (no auth) view a single listing's detail page.
CREATE TABLE IF NOT EXISTS share_tokens (
  token       TEXT PRIMARY KEY,
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- who created it
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_listing ON share_tokens(listing_id);

-- ============ SEED STATIC DATA ============
INSERT INTO cities (id, name, name_pl, slug, lat, lng) VALUES
  (1, 'Warsaw',    'Warszawa',  'warsaw',    52.2297, 21.0122),
  (2, 'Kraków',    'Kraków',    'krakow',    50.0647, 19.9450),
  (3, 'Wrocław',   'Wrocław',   'wroclaw',   51.1079, 17.0385),
  (4, 'Gdańsk',    'Gdańsk',    'gdansk',    54.3520, 18.6466),
  (5, 'Poznań',    'Poznań',    'poznan',    52.4064, 16.9252)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  name_pl = EXCLUDED.name_pl,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng;

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (1, 'OLX',    'olx',    '#0A6E68', 'https://www.olx.pl'),
  (2, 'Otodom', 'otodom', '#A4133C', 'https://www.otodom.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
