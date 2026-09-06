-- migration_003: Telegram notifications + app settings

-- Key-value app settings (shared bot token etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user telegram notification rules
CREATE TABLE IF NOT EXISTS telegram_settings (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  min_price   INTEGER,
  max_price   INTEGER,
  region_ids  UUID[] NOT NULL DEFAULT '{}',   -- empty = no region filter (whole city)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- What we've already sent (never notify twice about the same listing)
CREATE TABLE IF NOT EXISTS telegram_sent (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_tgsent_listing ON telegram_sent(listing_id);
