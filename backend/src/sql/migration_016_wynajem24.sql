-- migration_016: wynajem24.pl source (Task D-wynajem24-11)
-- Wynajem24.pl — Polish rental-only classifieds portal running Flynax
-- Classifieds Software. Free, no agency fees, mid-three-figure national
-- inventory (~62 active listings across all cities; ~9 Warszawa mieszkania
-- at any one time). Plain fetch() works (no Cloudflare, no anti-bot, no
-- Playwright fallback needed). Search-page pagination does NOT work
-- (`?page=N`, `?pg=N`, `/pg/N/`, `/page/N/`, `?from=N`, `/N.html` all
-- either 404 or return the same first-page content). The scraper uses
-- the sitemap_listings1.xml (256 KB / 186 <loc> entries — 62 unique × 3
-- languages pl/en/ru) as the canonical URL discovery source, then fetches
-- each detail page for the JSON-LD Product block + df_field_* field
-- values. Detail page JSON-LD has: sku=externalId, name=title, image[]
-- (4-8 `_large.webp` photos), description (full Polish text), offers.price
-- + priceCurrency="ZLOTY" (normalized to "PLN" on the way out). Lat/lng
-- from Google Static Map URL in HTML (city-level fallback — meets the
-- "lat/lng not null" quality bar with a small loss of precision).
-- Independent (not part of the Morizon/Gratka/Agora oligopoly) — some
-- cross-source overlap expected with olx direct-from-owner listings;
-- caught by services/dedupe.js via geo + area + rooms fingerprint.
--
-- Source id 17 — after 15 (okolica, D10). Slot 16 reserved for a parallel
-- D-chunk scraper (likely rentola.pl or another tier-2 source in a
-- parallel D-chunk task). Migration_016 → source_id 17 to keep the
-- migration sequence monotonic.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (17, 'Wynajem24', 'wynajem24', '#5D4FFF', 'https://wynajem24.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
