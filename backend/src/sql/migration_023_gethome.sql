-- migration_023: gethome.pl source (Task D-gethome-4)
--
-- gethome.pl is a PropertyGroup Sp. z o.o. real-estate portal (sister of
-- tabelaofert.pl, source_id=12, and ex-RynekPierwotny). Carries 863 Warszawa
-- wynajem listings across ~25 pages × 35/page, including a 26-listing
-- direct-from-owner subset reachable via the /t/bez-posrednikow/ tag path
-- (we walk the unfiltered inventory — `is_private` flag per offer covers
-- the direct-from-owner signal at the data layer).
--
-- URL pattern (verified 2026-08-29 via z-ai page_reader on live pages):
--   Search:  https://gethome.pl/mieszkania/do-wynajecia/<miasto>/?page=N
--   Detail:  https://gethome.pl/oferta/<slug>/            (trailing slash canonical)
--   Per offer external id: UUID (stable across re-edits; slugs change with
--   title edits). The brief hypothesized `/mieszkanie/<id>` — that path
--   404s; the actual detail URL pattern is `/oferta/<slug>/`.
--
-- Site is a React SPA that pre-renders the initial state into a literal
-- `<script>window.__INITIAL_STATE__ = {…big JSON blob…};</script>` block.
-- The blob has structure offerList.offers.offers[] with rich per-offer
-- data (price.total, coordinates.lat/lon, created_at, description (250
-- char truncated server-side), property.room_number/size/floor, pictures[]
-- (6-21 entries — meets the 8-12 photo quality bar), is_private flag).
-- The detail page's window.__INITIAL_STATE__.offer.offer.description
-- holds the full Polish text (500-2500 chars).
--
-- Anti-bot: gethome.pl is behind Cloudflare with "Just a moment..."
-- interstitial on every cold request. Plain fetch() always returns 403 +
-- the challenge HTML (verified 2026-08-29). The scraper detects the
-- challenge and falls back to Playwright's fetchRendered() (browser.js),
-- same pattern as odwlasciciela.js (source_id=13). Cost: ~3-5s for the
-- first fetch per process (browser launch), faster on subsequent fetches.
--
-- Source id 11 — slot was free in the existing SCRAPERS map (1,2,3,4,5,7,
-- 8,9,10,12,13,14,15,16,17,18,19,20,21 are taken; 6 and 11 are skipped).
-- Migration file 023 — slot 022 is taken by allegro (Task D-allegro-14,
-- source_id=21); slot 010 was originally reserved by the orchestrator for
-- the gethome scraper but never created (the orchestrator's chunk-scheduling
-- model left 010 open as a placeholder). We use 023 to keep the migration
-- sequence monotonic and avoid colliding with any in-flight D-chunk
-- subagents that may pick up slot 010.
--
-- Cross-source dedupe overlap: HIGH with tabelaofert (source_id=12) — same
-- PropertyGroup parent, the two portals cross-publish owner-direct
-- listings. Also LOW-MEDIUM overlap with olx/otodom direct-from-owner
-- listings (caught by services/dedupe.js via geo + area + rooms fingerprint).
-- The remaining agency-exclusive listings are the incremental signal.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (11, 'Gethome', 'gethome', '#9069c0', 'https://gethome.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
