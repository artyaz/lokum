-- migration_009: domiporta.pl source (Task D2)
-- Agora SA portal — 2 556 Warszawa wynajem listings across ~71 pages × 36/page.
-- JSON-LD on both search and detail pages, plain fetch() works (no Cloudflare,
-- no anti-bot, no Playwright). Detail pages carry lat/lng (itemOffered.geo),
-- full gallery in JSON-LD image[] (5-10 photos), and full Polish description
-- in <div class="description__panel">. Sister of Morizon/Gratka via shared
-- schema.org Product/RealEstateListing JSON-LD platform; high cross-source
-- overlap expected — caught by services/dedupe.js via geo + area + rooms
-- fingerprint.
--
-- Source id 9 — between 8 (nieruchomosci-online, D1) and 10 (oferty-net, D3).

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (9, 'Domiporta', 'domiporta', '#FA4A4E', 'https://www.domiporta.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
