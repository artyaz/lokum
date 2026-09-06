-- migration_014: okolica.pl source (Task D10)
-- Okolica.pl — Warsaw-centric map-based rental portal (1 747 Warszawa wynajem
-- listings, 213 direct-from-owner subset). Map-based UI backed by a public
-- JSON markers/search API (returns [lat, lng, external_id, ...] for every
-- listing within the city bounds in a single 79 KB response). Search page
-- emits rich server-rendered cards with 8-12 photo thumbs + price + rooms +
-- area + floor + district + relative timestamp. Detail pages carry full
-- Polish description in <div class="desc">, ISO datePosted in JSON-LD
-- RealEstateListing block, and a direct-from-owner marker in <div
-- class="ownerType">. Plain fetch() works (no Cloudflare, no anti-bot,
-- no Playwright fallback needed). Independent (not part of the Morizon/Gratka/
-- Agora oligopoly) — some cross-source overlap expected with olx/otodom
-- direct-from-owner listings; caught by services/dedupe.js via geo + area +
-- rooms fingerprint.
--
-- Source id 15 — after 12 (tabelaofert, D5). Slot 13 is reserved for a
-- parallel D-chunk scraper; slot 14 was reserved similarly (likely for a
-- new gethome.pl or rentola.pl source in a parallel D-chunk task).
-- Migration_014 → source_id 15 to keep the migration sequence monotonic
-- while leaving the source-id slot free for any pre-empted parallel work.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (15, 'Okolica', 'okolica', '#F6AE39', 'https://www.okolica.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
