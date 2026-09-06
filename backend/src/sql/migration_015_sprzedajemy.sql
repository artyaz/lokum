-- migration_015: sprzedajemy.pl source (Task D-sprzedajemy-8)
-- Polish general classifieds portal owned by Grupa OLX sp. z o.o. Small but
-- distinct rentals sub-inventory: ~158 Warszawa wynajem listings at any given
-- moment, 30 listings/page across ~5-6 pages. Search page emits per-card
-- details (title/price/area/rooms/floor/postedAt/district/thumbnail/sellerType)
-- plus PARTNER PREMIUM + ZWERYFIKOWANA FIRMA badges. Detail pages carry a
-- Product+Organization JSON-LD block with FULL Polish description + 8-12
-- high-res photos + offers.Price (with capital P — schema violation we work
-- around defensively). Coords live in a Python-style single-quoted dict on
-- a `data-coordinates` attribute on the .location row. Plain fetch() works
-- (no Cloudflare, no anti-bot, no Playwright fallback needed). High cross-
-- source dedupe overlap expected with olx.pl (sister portal) and odwlasciciela.pl
-- (which cross-posts to sprzedajemy) — caught by services/dedupe.js via geo +
-- area + rooms fingerprint.
--
-- Source id 16 — after 15 (okolica, D10). Migration_015 keeps the migration
-- sequence monotonic with the source id.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (16, 'Sprzedajemy', 'sprzedajemy', '#E4791F', 'https://sprzedajemy.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
