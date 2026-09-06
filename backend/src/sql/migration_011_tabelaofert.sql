-- migration_011: tabelaofert.pl source (Task D5)
-- PropertyGroup Sp. z o.o. portal (sister of gethome.pl, ex-RynekPierwotny).
-- Direct-from-owner rental inventory via the `?klient_typ=osoba_prywatna`
-- URL filter. ~210-240 Warszawa owner-direct rent listings across ~7 pages
-- × 30/page. Plain fetch() works (no Cloudflare, no anti-bot, no Playwright).
-- Search page emits a rich JSON-LD AggregateOffer with geo + price + rooms +
-- area + floor + address embedded per offer (no detail fetch needed for
-- coords — only for full description + gallery). High cross-source dedupe
-- overlap expected with olx/otodom direct-from-owner listings — caught by
-- services/dedupe.js via geo + area + rooms fingerprint.
--
-- Source id 12 — after 9 (domiporta, D2) and 10 (oferty-net, D3); slot 11
-- reserved by the orchestrator for a parallel D-chunk scraper (likely
-- gethome.pl, D4).

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (12, 'Tabelaofert', 'tabelaofert', '#1A8A6E', 'https://tabelaofert.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
