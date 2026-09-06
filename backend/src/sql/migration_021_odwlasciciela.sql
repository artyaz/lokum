-- migration_021: odwlasciciela.pl direct-from-owner portal (Task D-odwlasciciela-6)
--
-- odwlasciciela.pl ("From Owner") is a Polish direct-from-owner rental portal.
-- Every listing on the site is published by the property owner (the
-- "Bezpośrednio" badge is shown on every card), so cross-source dedupe overlap
-- with OLX / Otodom's agency-fed listings is minimal — the unique value-add of
-- this source is its 100% owner-direct inventory.
--
-- URL pattern (verified 2026-08-30 via curl + z-ai page_reader on live pages):
--   Search: https://odwlasciciela.pl/mieszkania/wynajem/<wojewodztwo>,<miasto>.html?offset=N
--           e.g. https://odwlasciciela.pl/mieszkania/wynajem/mazowieckie,warszawa.html
--   Detail: https://odwlasciciela.pl/oferty/podglad/<id>,mieszkanie-wynajme.html
--   20 listings/page (Warsaw yields ~30-50 pages = ~600-1000 listings).
--   NOTE: the task brief mentioned the URL `odwlasciciela.pl/mieszkania/warszawa`
--   but that path returns the anti-bot challenge page (no listings). The
--   canonical search URL is the longer `/mieszkania/wynajem/<woj>,<miasto>.html`
--   form (verified via web-search + page_reader).
--
-- Anti-bot: the site uses a "wsidchk"/"pdata" JS verification challenge on
-- EVERY cold request — plain fetch() always returns the challenge HTML (HTTP
-- 200 with a 5-second meta-refresh + a JS form submit). We detect the
-- challenge page and fall back to Playwright's `fetchRendered()` (browser.js),
-- which passes the checks via the stealth init script. Cost: ~3-5s for the
-- first fetch per process (browser launch), faster on subsequent fetches.
--
-- Field availability (per Task D brief + verification):
--   - Photos: full slick slider gallery, typically 8-12 unique photos per
--     listing (sample listing 43366 has 11 photos, 43254 has 10). Direct-from-
--     owner listings often have fewer — we extract what's there.
--   - Description: full Polish text from JSON-LD RealEstateListing.description
--     (preserves \r\n line breaks as \n). Verified ~800 words on sample
--     listing (6 paragraphs incl. układ / lokalizacja / koszty / FAQ).
--   - Price: PLN/monthly from the search card's `<span class="text
--     text--medium text--black font-weight-bold">3 000 <small>PLN</small>
--     </span>` (the detail JSON-LD has no price field, only `expires`).
--   - Location (lat/lng): NO listing-specific coords on the detail page —
--     the map code is COMMENTED OUT (`// var latlng = new google.maps.LatLng
--     (52.05249, 18.984375);` is a default Poland center, not the listing's
--     coords). We fall back to city-level coords (city.lat / city.lng) to
--     satisfy the "lat/lng not null" quality bar. (Same tradeoff as
--     wynajem24.js — small loss of precision but services/dedupe.js catches
--     overlap via area + rooms fingerprint regardless of coord precision.)
--   - rooms / area / floor: from the search card's attribute spans + the
--     detail page's params table__row blocks (Powierzchnia użytkowa, Liczba
--     pokoi, Piętro). Detail-page values are more reliable.
--   - postedAt: from JSON-LD RealEstateListing.datePosted
--     ("2026-08-26 21:59:13" Europe/Warsaw local → ISO with +01:00 offset).
--
-- External id format: the numeric id from the detail URL path
-- (`/oferty/podglad/<id>,mieszkanie-wynajme.html` → "<id>"). Source-scoped —
-- no collision with other sources' external_id namespaces.
--
-- Source id 13 — slot was free (1,2,3,4,5,7,8,9,10,12,14,15,16,17,18,19,20 are
-- taken; 6, 11, 13 are skipped in the existing SCRAPERS map). Migration number
-- 021 — slot was free (migration_012 = cron_run_job_id infrastructure;
-- migration_019 = telegram source_id=20; migration_020 reserved by the
-- orchestrator for a parallel D-chunk scraper per the task brief).
--
-- Cross-source dedupe overlap: LOW — odwlasciciela.pl's "Bezpośrednio"
-- (direct-from-owner) inventory is mostly exclusive to the portal. The
-- services/dedupe.js pipeline catches the small overlap via geo + area +
-- rooms fingerprint.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (13, 'OdWłaściciela', 'odwlasciciela', '#0E7C5A', 'https://odwlasciciela.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
