-- migration_006: encrypted Facebook cookie sessions for the scraper bridge

CREATE TABLE IF NOT EXISTS facebook_cookie_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  label              TEXT NOT NULL DEFAULT 'Browser export',
  encrypted_payload  TEXT NOT NULL,
  key_version        SMALLINT NOT NULL DEFAULT 1,
  c_user_hash        TEXT NOT NULL,
  xs_fingerprint     TEXT NOT NULL,
  expires_at         TIMESTAMPTZ,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_checked_at    TIMESTAMPTZ,
  last_status        TEXT,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_facebook_cookie_session
  ON facebook_cookie_sessions(is_active)
  WHERE is_active = TRUE;
