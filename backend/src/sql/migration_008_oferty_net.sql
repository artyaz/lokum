-- migration_008: oferty.net source (Task D3)
-- Old-school server-rendered HTML portal owned by Agora Group (Morizon + Gratka
-- sibling). 608k portal-wide listings; ~1380 mixed sale+rent listings for
-- Warszawa across 69 pages. Plain fetch() works (no anti-bot, no Playwright).
-- High cross-source dedupe overlap expected with Morizon + Gratka — caught
-- by services/dedupe.js via geo + area + rooms fingerprint.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (10, 'Oferty.net', 'oferty-net', '#5C6BC0', 'https://www.oferty.net')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
