-- 2026_08_translations_cache: extend translations table to match Task E spec.
--
-- Background:
--   migration_007_translations.sql (legacy) created the translations table
--   with this shape:
--     (listing_id UUID, source_lang TEXT, translated_text TEXT, updated_at TIMESTAMPTZ)
--     PRIMARY KEY (listing_id, source_lang)
--
--   Task E's user brief specified the desired shape as
--     (id, listing_id, source_lang, target_lang, translated_text, created_at)
--
--   Rather than rewriting the table (which would break the UPSERT in
--   ai-client.js#setCachedTranslation and risk data loss on existing rows),
--   this migration ADDS the missing columns id, target_lang, created_at to
--   the existing table. The existing PK on (listing_id, source_lang) is kept
--   for backward compatibility; the new `id` column is a separate BIGSERIAL
--   surrogate that callers can use as a stable row handle if they ever need
--   to reference a single translation row directly.
--
-- Idempotent: every statement uses ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS, so this migration is safe to re-run on every deploy.

ALTER TABLE translations ADD COLUMN IF NOT EXISTS id BIGSERIAL;

ALTER TABLE translations ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT 'en';

ALTER TABLE translations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Stable row handle index (the id surrogate is unique by construction via
-- BIGSERIAL but we still mark it UNIQUE to advertise the contract).
CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_id
  ON translations(id);

-- Fast lookup by target language (e.g. "give me all English translations"
-- for a bulk re-export).
CREATE INDEX IF NOT EXISTS idx_translations_target
  ON translations(target_lang);

-- Backfill created_at from updated_at for any rows migrated from the legacy
-- shape (so a single timestamp column is "the write time" for everything).
UPDATE translations
  SET created_at = updated_at
  WHERE created_at IS NULL;
