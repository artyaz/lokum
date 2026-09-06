-- migration_004: duplicates, AI total price, extra sources

-- Cross-source duplicate pairs (same flat on different sites).
-- Canonical: id_a < id_b (uuid ordering), one row per pair.
CREATE TABLE IF NOT EXISTS listing_duplicates (
  id_a        UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  id_b        UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  score       REAL NOT NULL,               -- 0..1 match confidence
  reasons     JSONB NOT NULL DEFAULT '[]', -- ["geo 40m", "area equal", "rooms equal", ...]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id_a, id_b)
);
CREATE INDEX IF NOT EXISTS idx_dup_a ON listing_duplicates(id_a);
CREATE INDEX IF NOT EXISTS idx_dup_b ON listing_duplicates(id_b);

-- AI-estimated total monthly cost (rent + admin fees + utilities...)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS total_estimate INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS total_breakdown JSONB;
-- breakdown shape: { items: [{label, amount_pln}], notes: string, computed_at: iso }

-- Additional listing sources
-- (Gumtree.pl shut down in 2022 and its domain is dead, so direct-owner
-- listings come from Adresowo instead; id 3 keeps the original sequence.)
INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (3, 'Adresowo',  'adresowo',  '#3E82A8', 'https://adresowo.pl'),
  (4, 'Gratka',    'gratka',    '#7B5EA7', 'https://gratka.pl'),
  (5, 'Morizon',   'morizon',   '#B08968', 'https://www.morizon.pl'),
  (6, 'Community', 'community', '#5B574E', 'https://flats.chmyl.com')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
