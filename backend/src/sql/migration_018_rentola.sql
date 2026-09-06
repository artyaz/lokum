-- migration_018: rentola.pl source (Task D-rentola-12)
-- Rentola.pl — Polish rental aggregator portal (~10 000 Warszawa wynajem
-- listings, ~50 655 listings network-wide in Poland). Aggregator: re-publishes
-- listings scraped from Otodom, Nieruchomosci-online, OLX, and individual
-- agency XML feeds (the inline RSC payload exposes the source URL — e.g.
-- artservice.waw.pl/nieruchomosci/show/<id> for the listing's source).
-- Plain fetch() works — Next.js SSR + Cloudflare (no anti-bot challenge
-- shown at the HTML layer; full JSON-LD blocks come through). No Playwright
-- fallback needed.
--
-- Search page emits a JSON-LD SearchResultsPage block with mainEntity.
-- itemListElement[] of ListItems, each having a RealEstateListing .item
-- with: url, name, image (single thumbnail), offers.price + priceCurrency +
-- validFrom, itemOffered.address.streetAddress + addressLocality,
-- itemOffered.geo.latitude/longitude (REAL per-property coords),
-- itemOffered.floorSize.value + unitCode "MTK" (m²), and itemOffered.
-- numberOfBedrooms (NOTE: rentola mislabels pokoje count as "numberOfBedrooms"
-- — verified: same listing has numberOfBedrooms=4 on search AND numberOfRooms=4
-- on detail).
--
-- Detail page (/listings/<slug>-p<6-hex-chars>) emits a JSON-LD
-- RealEstateListing block with: name (full Polish title), description (FULL
-- Polish text — not truncated like domiporta), datePosted (ISO 8601 with Z),
-- url, image[] (8-12+ photos — meets the quality bar minimum), offers.price
-- + priceCurrency (PLN/monthly) + validFrom, itemOffered.address.streetAddress
-- (real street, e.g. "Odkryta 56, 03-140 Warsaw, Poland") + addressLocality
-- + addressRegion (Polish województwo), itemOffered.geo.latitude/longitude
-- (REAL per-property coords, verified 52.334477,20.9370143 for Odkryta 56),
-- itemOffered.floorSize.value + unitCode "MTK" (m²), and itemOffered.
-- numberOfRooms.value (Polish pokoje count).
--
-- Floor: NOT in JSON-LD. rentola stores it inside the Next.js RSC flight
-- payload as `floorNumber` (often null — rentola doesn't parse floor from
-- source description text). Scraper regex-extracts floorNumber from the
-- inline JS, with a regex fallback on the description text for "na N. piętrze"
-- Polish pattern. Conveniences: extracted from the inline RSC payload's
-- `facilities` array (English lowercase strings: "furnished", "balcony",
-- "terrace", "garage", "parking", ...).
--
-- Source id 19 — after 18 (lento, Task D-lento-9, migration_017).
-- Migration_018 → source_id 19 to keep the migration sequence monotonic
-- with the source id. (Slot 11 was reserved by the orchestrator but
-- unused; slots 13, 14 were similarly reserved and unused — these
-- gaps in the migration sequence are intentional and reflect the
-- chunked-implementation subagent scheduling model.)
--
-- High cross-source dedupe overlap expected (rentola aggregates from Otodom,
-- Nieruchomosci-online, OLX — all of which we already cover). The remaining
-- ~20-40% of listings are exclusive listings rentola scraped from smaller
-- agency XML feeds (e.g. artservice.waw.pl, brik.com.pl, domy.pl,
-- realton.pl) that we don't otherwise cover. Caught by services/dedupe.js
-- via geo + area + rooms fingerprint.

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (19, 'Rentola', 'rentola', '#FF6B35', 'https://rentola.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
