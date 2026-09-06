-- Migration 007: translations cache table
--
-- Lets re-runs skip listings we've already translated. Keyed by
-- (listing_id, source_lang) so a multi-language future is possible.
-- Mirrored in backend/src/services/ai-client.js (getCachedTranslation /
-- setCachedTranslation).
CREATE TABLE IF NOT EXISTS translations (
  listing_id       UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  source_lang      TEXT NOT NULL DEFAULT 'pl',
  translated_text  TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (listing_id, source_lang)
);
CREATE INDEX IF NOT EXISTS idx_translations_lang ON translations(source_lang);
