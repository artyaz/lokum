-- migration_017: lento.pl source (Task D-lento-9)
-- Lento.pl — Polish free general classifieds portal with a small but distinct
-- rentals sub-inventory (~250 Warszawa wynajem listings across ~7 pages × 37
-- cards/page). Independent (not part of the Morizon/Gratka/Agora oligopoly)
-- — high direct-from-owner ("bez pośredników") share makes it a useful
-- incremental signal for the cheap long-tail segment. Plain fetch() works
-- (no Cloudflare, no anti-bot, no Playwright fallback needed). Detail pages
-- emit a JSON-LD RealEstateListing block with: name, description (full
-- Polish text), image[] (full-res /original/ variants, 4-12 typical),
-- datePosted (ISO date), offers.price + priceCurrency="PLN", mainEntity
-- Apartment{numberOfRooms, floorLevel, yearBuilt, address}, geo{lat,lng}.
-- ~30-40% of listings lack the RealEstateListing block — for those we
-- extract lat/lng from `<div class="box-map-show" data-lat data-lng>` and
-- the full description from `<div class="desc text-15"><h3>Opis oferty</h3>
-- ...</div>`. The 5-card params table (Powierzchnia, Liczba pokoi, Piętro,
-- Liczba pięter, Inf. dodatkowe) is always present in HTML.
--
-- Source id 18 — after 17 (wynajem24, Task D-wynajem24-11). Migration_017
-- → source_id 18 to keep the migration sequence monotonic.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (18, 'Lento', 'lento', '#1B5E20', 'https://warszawa.lento.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
