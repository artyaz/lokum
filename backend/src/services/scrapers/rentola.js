// rentola.pl scraper — Polish rental aggregator portal (10 000 Warszawa wynajem
// listings, 50 570 listings network-wide in Poland). Aggregator: re-publishes
// listings scraped from Otodom, Nieruchomosci-online, OLX, individual agency
// XML feeds. Plain fetch() works — Next.js SSR + Cloudflare (no anti-bot
// challenge shown at the HTML layer; full JSON-LD blocks come through).
// No Playwright fallback needed.
//
// Site layout (verified 2026-08-29 via curl + page inspection on live pages):
//
//   Search:  https://rentola.pl/wynajem/mieszkanie/<city>?page=N
//            e.g. https://rentola.pl/wynajem/mieszkanie/warszawa?page=2
//            21 listings/page, ?page=N works up to ~50+ (page=100 returns
//            HTTP 404 — server's hard cap is between 50 and 100). The site
//            silently redirects to /pl/wynajem/mieszkanie/<city> via
//            x-middleware-rewrite, but the listing URLs in the JSON-LD
//            stay on the canonical https://rentola.pl/listings/... form.
//
//            Search JSON-LD: <script type="application/ld+json">{
//              "@context":"https://schema.org",
//              "@type":"SearchResultsPage",
//              "mainEntity":{
//                "@type":"ItemList",
//                "itemListElement":[
//                  {"@type":"ListItem","position":1,"url":"https://rentola.pl/listings/<slug>-p<6-hex>","item":{
//                    "@type":"RealEstateListing",
//                    "name":"apartment in ul. Powstańców, Katowice, Śródmieście",
//                    "url":"https://rentola.pl/listings/<slug>-p<6-hex>",
//                    "image":"https://realton.pl/wp-content/uploads/2026/08/113905523-972x623.jpg",
//                    "offers":{"@type":"Offer",
//                      "availability":"https://schema.org/InStock",
//                      "price":2150,"priceCurrency":"PLN",
//                      "url":"https://rentola.pl/listings/<slug>-p<6-hex>",
//                      "validFrom":"2026-08-21T05:11:37Z",
//                      "itemOffered":{"@type":"Apartment",
//                        "address":{"@type":"PostalAddress",
//                          "streetAddress":"Śródmieście, Warszawa, Poland",
//                          "addressCountry":"PL",
//                          "addressLocality":"Warszawa"},
//                        "geo":{"@type":"GeoCoordinates",
//                          "latitude":52.22904,"longitude":21.01644},
//                        "floorSize":{"@type":"QuantitativeValue","value":35,"unitCode":"MTK"},
//                        "numberOfBedrooms":{"@type":"QuantitativeValue","value":1}}
//                    }}
//                  }}
//                ]
//              }
//            }
//            NOTE: rentola's `numberOfBedrooms` is actually the Polish pokoje
//            count (verified: same listing has numberOfBedrooms=4 on search
//            AND numberOfRooms=4 on detail — rentola mislabeled the field).
//            We prefer the detail page's `numberOfRooms` (canonical).
//
//   Detail:  https://rentola.pl/listings/<slug>-p<6-hex-chars>
//            e.g. https://rentola.pl/listings/dwupokojowe-mieszkanie-do-wynajecia-p1bb973
//            The 6-hex-chars suffix is the listing's external id (unique
//            across the site). Server-renders a JSON-LD RealEstateListing
//            block with:
//              name (full Polish title — better than search card's address-y name)
//              description (FULL Polish text — NOT truncated like domiporta)
//              datePosted (ISO 8601 timestamp with Z)
//              url
//              image[] (8-12+ photos — meets quality bar; verified 11 photos
//                on listing pf94506, 9 photos on p1bb973)
//              offers.price + priceCurrency (PLN/monthly)
//              offers.validFrom (ISO timestamp — same as datePosted usually)
//              offers.itemOffered.address.streetAddress (real street,
//                e.g. "Odkryta 56, 03-140 Warsaw, Poland")
//              offers.itemOffered.address.addressLocality ("Warszawa")
//              offers.itemOffered.address.addressRegion ("województwo mazowieckie")
//              offers.itemOffered.geo.latitude/longitude (REAL per-property
//                coords — verified 52.334477,20.9370143 for Odkryta 56
//                [Targówek/Białołęka boundary, not city-center fallback])
//              offers.itemOffered.floorSize.value + unitCode "MTK" (m²)
//              offers.itemOffered.numberOfRooms.value (Polish pokoje count)
//
//            Floor: NOT in JSON-LD. rentola stores it inside the Next.js
//            RSC flight payload as `floorNumber` (often null — rentola
//            doesn't parse floor from source description text). We regex-
//            extract `"floorNumber":(N|null)` from the inline JS, with a
//            regex fallback on the description text for "na N. piętrze"
//            (verified: description "Mieszkanie znajduje się na 3. piętrze
//            w 4-piętrowym budynku" → floor="3").
//
//            Conveniences: extracted from the inline RSC payload's
//            `facilities` array — lowercase English strings:
//              ["furnished","balcony","terrace","garage","parking",...]
//            We map these to our internal convenience types.
//
//   Sample h1 (visible to users on the detail page):
//            "mieszkanie z 4 pokojami o powierzchni 100 m² w mieście Warszawa"
//            The h1 is more user-friendly than the JSON-LD name; we use
//            the JSON-LD name for the title (it's more specific — includes
//            the street/district).
//
// Quality bar (per Task D brief):
//   - lat/lng: JSON-LD itemOffered.geo (REAL per-property coords — must not
//     be null. We sanity-check the Poland bounding box: 49<lat<55, 14<lng<24.)
//   - photos: JSON-LD image[] (8-12+ URLs — meets the minimum)
//   - description: JSON-LD description (FULL Polish text — not truncated)
//   - price: PLN/monthly from JSON-LD offers.price
//
// Dedupe overlap (per C3 research §11.3): rentola.pl is an AGGREGATOR — it
// re-publishes listings from Otodom, Nieruchomosci-online, OLX, individual
// agency XML feeds. We expect HIGH dedupe overlap (60-80% discarded via
// services/dedupe.js geo + area + rooms fingerprint). The remaining
// ~20-40% are exclusive listings rentola scraped from smaller agency XML
// feeds that we don't otherwise cover.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 19;
// 21 listings/page × 30 pages = ~630 listings/city/fetch — ~6.3% of the
// 10 000-listing Warszawa inventory. Pairs with the 3×/day recommended
// schedule (B8) so each fetch catches every listing added in the past ~8h
// with margin to spare. Beyond ~50 pages, rentola returns HTTP 404, so
// MAX_PAGES=30 also keeps us clear of the site's hard cap.
const MAX_PAGES = 30;
// Stop the detail-page fetch pool after this many consecutive fetch
// failures (transient 5xx, DNS, connection reset). Same value as
// domiporta/ofertyNet/nieruchomosciOnline/okolica/wynajem24 — 3 strikes
// → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// Promise pool concurrency for the detail-page fetch step. Same value as
// domiporta/gratka/morizon/adresowo/ofertyNet/nieruchomosciOnline/okolica
// /tabelaofert/wynajem24 for parity — 4 workers strikes the right balance
// between throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;
// Cap the number of detail-page fetches per cycle to bound runtime + RAM.
// 630 search-walk cap above is already the practical bound; ENRICH_LIMIT
// is a defensive backstop in case MAX_PAGES is overridden via env var.
const ENRICH_LIMIT = 700;
// rentola search results return exactly 21 listings/page (verified across
// pages 1, 2, 5, 10, 30, 50).
const OFFERS_PER_PAGE = 21;

// City path map — rentola uses the lowercase Polish city name as the
// URL segment. The site also exposes sub-types like /kawalerka/<city>
// (1995 Warszawa studios), /mieszkanie-studenta/<city> (1925 student
// apartments) — but the parent /mieszkanie/<city> path covers ALL
// apartment types, so we restrict to that to avoid triple-counting.
const CITY_PATH = {
  warsaw:  'warszawa',
  krakow:  'krakow',
  wroclaw: 'wroclaw',
  gdansk:  'gdansk',
  poznan:  'poznan'
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: rentola's JSON-LD prices are clean Numbers (no
// thousand separators), but `floorSize.value` can be 45.2 (decimal) or
// 100 (integer). We accept both forms and skip any non-numeric noise.
// Mirrors domiporta.js's parseNum but simpler (rentola's data is cleaner).
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Strip HTML tags + decode entities from a fragment. Used for the
// description field when the JSON-LD description carries embedded HTML
// entities (`&lt;` / `&gt;`) — leave the JSON-LD text as-is otherwise
// (rentola's description is plain text, verified on two listings).
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/[a-z]+>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class RentolaScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as gratka/ofertyNet/
  // domiporta/nieruchomosciOnline/okolica/wynajem24. The detail-page
  // enrichment (full photos / full Polish description / floor from inline
  // RSC payload) needs to run AFTER the search walk, and the streaming
  // `onListing` path skips this step. We retain the listings array
  // (~3.5 MB for ~630 listings × 5 KB payload) and then run the 4-worker
  // detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'rentola',
      baseUrl: 'https://rentola.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('RENTOLA_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // The site supports price filters via /<N>-pln/<city> path segments
      // (e.g. /wynajem/mieszkanie/1500-pln/warszawa for "from 1500 PLN").
      // We leave the filter to the runner's defensive pass — the URL
      // builder here would need to translate maxPrice → nearest step
      // (800/1000/1200/1500/2000/...), and a mis-translation silently
      // narrows the result set. Runner-level filter is safer.
      const qs = params.toString();
      const url = `${this.baseUrl}/wynajem/mieszkanie/${cityPath}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[rentola] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[rentola] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip
        // doesn't cascade into a hard abort and skip the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0; // reset on success

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[rentola] ${city.slug}: no cards on page 1`);
        else console.log(`[rentola] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      let dupCount = 0;
      for (const card of cards) {
        seen++;
        if (seenExternalIds.has(card.externalId)) {
          dupCount++;
          continue;
        }
        seenExternalIds.add(card.externalId);
        // Pre-filter by price at the URL level when possible — saves a
        // detail-page fetch when the search card already has the price
        // (rentola always includes offers.price on the search card).
        if (filters.maxPrice != null && card.price && card.price > filters.maxPrice) continue;
        if (filters.minPrice != null && card.price && card.price < filters.minPrice) continue;
        if (onListing) await onListing(card);
        else ads.push(card);
      }
      console.log(
        `[rentola] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 21 cards each; the true
      // last page returns fewer. Use HALF of OFFERS_PER_PAGE as the
      // threshold so a natural fluctuation of ±1-2 cards doesn't trigger
      // a false break.
      if (cards.length < Math.ceil(OFFERS_PER_PAGE / 2)) {
        console.log(`[rentola] ${city.slug} page ${page}: short page (${cards.length}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse the search-results JSON-LD. The page emits a single
  // SearchResultsPage block whose mainEntity is an ItemList of ListItems.
  // Each ListItem.item is a RealEstateListing with all the per-card fields
  // we need (price, geo, floorSize, numberOfBedrooms). We normalize each
  // to a card object.
  //
  // Fallback: if the JSON-LD ItemList is missing (defensive — never seen
  // on rentola), regex-scan for /listings/<slug>-p<6-hex> detail URLs.
  _parseSearchCards(html, city) {
    const out = [];
    const blocks = this._extractJsonLd(html);

    let items = null;
    for (const b of blocks) {
      if (b?.['@type'] === 'SearchResultsPage' && b?.mainEntity?.itemListElement) {
        items = b.mainEntity.itemListElement;
        break;
      }
      if (b?.['@type'] === 'ItemList' && Array.isArray(b.itemListElement)) {
        items = b.itemListElement;
        break;
      }
    }
    if (items) {
      for (const li of items) {
        // The ListItem can either nest the RealEstateListing under .item
        // OR be the RealEstateListing itself (rentola uses .item).
        const item = li?.item || li;
        const card = this._normalizeSearchCard(item, city);
        if (card) out.push(card);
      }
      return out;
    }

    // Fallback: regex-scan for listing URLs in the canonical form.
    const re = /https?:\/\/(?:www\.)?rentola\.pl\/listings\/[a-z0-9-]+-p([a-f0-9]{6})/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(String(html))) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({
        externalId: m[1],
        url: this._normalizeUrl(m[0]),
        title: null,
        price: null,
        rooms: null,
        area: null,
        floor: null,
        district: city.name_pl,
        street: null,
        address: city.name_pl,
        description: '',
        postedAt: null,
        images: [],
        conveniences: [],
        raw: { url: m[0], via: 'regex-fallback' }
      });
    }
    return out;
  }

  // Map one JSON-LD RealEstateListing from the search results to a
  // normalized card object. Mirrors domiporta's _normalizeSearchItem but
  // rentola's shape puts the RealEstateListing at the top level (not
  // nested inside offers.itemOffered on the search card — it's a flat
  // shape with image/url/name/offers directly).
  _normalizeSearchCard(item, city) {
    if (!item || typeof item !== 'object') return null;
    const url = item.url;
    if (!url) return null;
    const externalId = this._extractIdFromUrl(url);
    if (!externalId) return null;

    const offers = item.offers || {};
    const price = parseNum(offers.price);
    if (!price || price <= 0) return null;

    const io = offers.itemOffered || {};
    const addr = io.address || {};
    const street = addr.streetAddress || null;
    const district = addr.addressLocality || city.name_pl;

    // floorSize.value (m²) — clean Number on rentola.
    const area = parseNum(io.floorSize?.value != null ? io.floorSize.value : null);

    // rentola's "numberOfBedrooms" is actually pokoje count (verified).
    // We use it as a fallback; _enrichNew overwrites with the detail
    // page's canonical numberOfRooms when present.
    let rooms = null;
    if (io.numberOfBedrooms != null) {
      const r = typeof io.numberOfBedrooms === 'object'
        ? parseNum(io.numberOfBedrooms.value)
        : parseNum(io.numberOfBedrooms);
      if (r != null) rooms = Math.round(r);
    }

    // Real per-property coords — sanity-check Poland bounding box.
    let lat = null, lng = null;
    if (io.geo?.latitude != null && io.geo?.longitude != null) {
      const la = parseFloat(io.geo.latitude);
      const ln = parseFloat(io.geo.longitude);
      if (Number.isFinite(la) && Number.isFinite(ln) &&
          la > 49 && la < 55 && ln > 14 && ln < 24) {
        lat = la; lng = ln;
      }
    }

    // Single thumbnail — full gallery comes from the detail-page JSON-LD
    // image[] (8-12+ photos).
    const images = item.image
      ? (Array.isArray(item.image) ? item.image : [item.image]).filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
      : [];

    // validFrom is an ISO timestamp with Z suffix — use as postedAt.
    // _enrichNew overwrites with the detail page's datePosted if present.
    let postedAt = null;
    const when = offers.validFrom || item.datePosted;
    if (when) {
      const d = new Date(String(when));
      if (!isNaN(d.getTime())) postedAt = d.toISOString();
    }

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: (item.name ? String(item.name).trim() : null) || `Mieszkanie ${district}`,
      description: '',
      price: Math.round(price),
      currency: offers.priceCurrency || 'PLN',
      rooms,
      area,
      floor: null, // backfilled from detail-page inline floorNumber
      district,
      street,
      address: [street, district].filter(Boolean).join(', ') || district,
      lat,
      lng,
      url: this._normalizeUrl(url),
      postedAt,
      images,
      conveniences: [],
      raw: { url, searchName: item.name || null }
    };
  }

  // Extract the 6-hex-chars external id from a rentola listing URL.
  //   https://rentola.pl/listings/<slug>-pf94506 → "f94506"
  //   https://rentola.pl/listings/dwupokojowe-mieszkanie-do-wynajecia-p1bb973 → "1bb973"
  // The id is always the last 6 hex chars after the final "-p" in the
  // path's last segment. Returns null when no match.
  _extractIdFromUrl(url) {
    const m = String(url).match(/-p([a-f0-9]{6})(?:[/?#]|$)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Enrich new listings (or known ones missing data) by fetching each
  // detail page and applying: full description, full photo gallery,
  // floor, numberOfRooms backfill, conveniences. Uses the 4-worker
  // Promise pool pattern (ENRICH_CONCURRENCY = 4) from domiporta/gratka
  // /ofertyNet/okolica/wynajem24 so we don't pin event-loop memory on a
  // ~630-listing walk.
  async _enrichNew(ads) {
    if (!ads.length) return;
    // Skip detail fetch for listings we've already enriched with >=3
    // photos — they're "done" (saved DB round-trips on re-runs).
    let knownWithImages = new Set();
    try {
      const rows = await many(
        `SELECT l.external_id FROM listings l
         WHERE l.source_id = $1 AND l.external_id = ANY($2::text[])
           AND (SELECT count(*) FROM listing_images li WHERE li.listing_id = l.id) >= 3`,
        [SOURCE_ID, ads.map(a => a.externalId)]
      );
      knownWithImages = new Set(rows.map(r => r.external_id));
    } catch {}
    const fresh = ads.filter(a => !knownWithImages.has(a.externalId)).slice(0, ENRICH_LIMIT);
    if (!fresh.length) {
      console.log(`[rentola] all ${ads.length} listings already enriched — skipping detail fetch`);
      return;
    }
    console.log(`[rentola] enriching ${fresh.length} listings (photos/desc/floor/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true, timeout: 20000 });
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't fail the whole walk
          console.warn(`[rentola] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as
        // domiporta/gratka/ofertyNet/okolica/wynajem24.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Sources, in
  // priority order:
  //   1. JSON-LD RealEstateListing block (primary source of truth)
  //      → photos (image[] 8-12+), lat/lng (itemOffered.geo),
  //        area (itemOffered.floorSize.value), rooms (itemOffered.numberOfRooms),
  //        street/district (itemOffered.address), price (offers.price),
  //        datePosted, full Polish description (NOT truncated on rentola)
  //   2. Inline Next.js RSC flight payload — floorNumber (often null)
  //      and facilities[] (English lowercase amenity strings). The RSC
  //      payload is inside `self.__next_f.push([1,"..."])` chunks — we
  //      regex-extract the two fields we need rather than parse the
  //      whole flight stream (cheaper + more robust to schema changes).
  //   3. Description text regex fallback — "na N. piętrze" Polish pattern
  //      when the inline floorNumber is null.
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD RealEstateListing block (primary source) ----
    const listing = this._extractListingBlock(s);
    if (listing) {
      // Photos — JSON-LD image[] gives 8-12+ full-res URLs. Cap at 20
      // (persistListing storage cap). Dedupe by URL.
      if (Array.isArray(listing.image) && listing.image.length) {
        const photos = [];
        const seen = new Set();
        for (const u of listing.image) {
          if (typeof u !== 'string') continue;
          if (seen.has(u)) continue;
          seen.add(u);
          photos.push(u);
          if (photos.length >= 20) break;
        }
        if (photos.length) ad.images = photos;
      } else if (typeof listing.image === 'string' && listing.image) {
        if (!ad.images.length) ad.images = [listing.image];
      }

      const offers = listing.offers || {};
      const io = offers.itemOffered || {};

      // Coords — MUST not be null per quality bar. Sanity-check the
      // Poland bounding box (rentola's geo is per-property, not city-
      // level, so we expect precise coords).
      if (io.geo?.latitude != null && io.geo?.longitude != null) {
        const lat = parseFloat(io.geo.latitude);
        const lng = parseFloat(io.geo.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            lat > 49 && lat < 55 && lng > 14 && lng < 24) {
          ad.lat = lat;
          ad.lng = lng;
        }
      }

      // Area (detail-page floorSize.value is the precise m²)
      if (io.floorSize?.value != null) {
        const a = parseNum(io.floorSize.value);
        if (a != null && a > 0) ad.area = a;
      }

      // Rooms — detail page's numberOfRooms is canonical. rentola's
      // search-card numberOfBedrooms is the same value (verified), but
      // we still overwrite from detail when present.
      if (io.numberOfRooms != null) {
        const r = typeof io.numberOfRooms === 'object'
          ? parseNum(io.numberOfRooms.value)
          : parseNum(io.numberOfRooms);
        if (r != null && r > 0) ad.rooms = Math.round(r);
      }

      // Address — prefer detail's street/district over search card's
      // (the detail streetAddress is more specific — includes the
      // postal code and English-form city name).
      const addr = io.address || {};
      if (addr.streetAddress) ad.street = String(addr.streetAddress);
      if (addr.addressLocality) ad.district = String(addr.addressLocality);
      ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;

      // Price — sanity-check (detail price should match search card)
      if (offers.price != null) {
        const p = Math.round(parseNum(offers.price));
        if (p > 0 && (!ad.price || Math.abs(p - ad.price) > Math.max(50, ad.price * 0.05))) {
          ad.price = p;
        }
      }

      // Currency
      if (offers.priceCurrency) {
        ad.currency = String(offers.priceCurrency);
      }

      // Title — detail page's name is the full Polish title. Only
      // overwrite when the search card didn't already set a meaningful
      // title (rentola's search-card name is often an address-y string,
      // while the detail name is "Dwupokojowe mieszkanie do wynajęcia:" —
      // the detail name is preferred).
      if (listing.name) {
        ad.title = String(listing.name).trim();
      }

      // datePosted — ISO timestamp with Z suffix
      if (listing.datePosted) {
        const d = new Date(String(listing.datePosted));
        if (!isNaN(d.getTime())) ad.postedAt = d.toISOString();
      } else if (offers.validFrom) {
        const d = new Date(String(offers.validFrom));
        if (!isNaN(d.getTime())) ad.postedAt = d.toISOString();
      }

      // Description — rentola's JSON-LD description is the FULL Polish
      // text (verified on two listings: 2557 chars + 5 paragraphs of
      // Polish). NOT truncated like domiporta. We use it directly.
      if (listing.description) {
        const desc = stripTags(listing.description);
        if (desc && desc.length > (ad.description || '').length) {
          ad.description = desc;
        }
      }
    }

    // ---- 2. Inline Next.js RSC flight payload — floorNumber + facilities ----
    // The RSC payload is inside self.__next_f.push([1,"..."]) chunks. The
    // JSON inside is double-escaped: \"floorNumber\":null appears as
    // \\"floorNumber\\":null in the rendered HTML. We strip the backslash
    // escapes once to get to the underlying JSON, then regex the two
    // fields we need.
    const clean = s.replace(/\\"/g, '"').replace(/\\u00a0/g, ' ').replace(/\\u0026/g, '&');

    // floorNumber — first occurrence is the listing's own value (the
    // second occurrence, when present, is for a similar-listings widget
    // further down the page).
    if (ad.floor == null) {
      const fm = clean.match(/"floorNumber":(null|\d+)/);
      if (fm && fm[1] !== 'null') {
        ad.floor = String(fm[1]);
      }
    }

    // facilities — array of English-lowercase amenity strings. The
    // inline payload also contains a "facilities":{"central":{...}}
    // object (a translation dictionary) — we skip that and only grab
    // the array form `facilities":["...",...]`.
    if (!ad.conveniences || !ad.conveniences.length) {
      const facM = clean.match(/"facilities":\[([^\]]{0,500})\]/);
      if (facM) {
        // Parse the comma-separated quoted list manually (the contents
        // are simple lowercase strings like "furnished" — no nested
        // quotes or escapes to worry about).
        const arrStr = '[' + facM[1] + ']';
        try {
          const arr = JSON.parse(arrStr);
          if (Array.isArray(arr)) {
            ad.conveniences = this._inferConveniences(arr);
          }
        } catch {
          // Ignore — fall back to empty conveniences
        }
      }
    }

    // ---- 3. Floor fallback from description text ----
    // rentola's floorNumber is often null (rentola doesn't parse floor
    // from the source description text). The description usually contains
    // a Polish sentence like "Mieszkanie znajduje się na 3. piętrze w
    // 4-piętrowym budynku" — regex-extract the unit's floor (first match
    // is the unit's floor; the second "4-piętrowym" form uses a hyphen
    // and won't match this regex).
    if (ad.floor == null && ad.description) {
      const fm = ad.description.match(/na\s+(\d+)\.?\s*pi[ęe]trze/i);
      if (fm) ad.floor = fm[1];
    }
  }

  // Find the JSON-LD block whose @type === "RealEstateListing" on a
  // detail page. rentola emits exactly one such block (verified on two
  // listings); we accept Product as a defensive alias in case rentola
  // changes the @type label later.
  _extractListingBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      const t = b?.['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes('RealEstateListing') || types.includes('Product')) {
        // Must have an `offers` block to be a real listing (weeds out
        // generic Product blocks for the site's own metadata).
        if (b?.offers && (b.offers.price != null || b.url)) return b;
      }
    }
    return null;
  }

  // Map rentola's English-lowercase facilities[] strings to our internal
  // convenience types. Mirrors the convention used by domiporta/wynajem24
  // (Polish labels → internal types). rentola uses English labels (it's
  // an aggregator that normalizes the source feeds), so the mapping here
  // is English → internal type.
  _inferConveniences(facilities) {
    const conv = [];
    if (!Array.isArray(facilities)) return conv;
    const seen = new Set();
    for (const f of facilities) {
      if (typeof f !== 'string') continue;
      const lower = f.toLowerCase().trim();
      if (!lower) continue;
      let type = null;
      let label = null;
      // Order matters — more specific labels first.
      if (lower === 'furnished' || lower === 'furniture') { type = 'furniture'; label = 'Umeblowane'; }
      else if (lower === 'balcony') { type = 'balcony'; label = 'Balkon'; }
      else if (lower === 'terrace') { type = 'balcony'; label = 'Taras'; }
      else if (lower === 'garage') { type = 'garage'; label = 'Garaż'; }
      else if (lower === 'parking') { type = 'park'; label = 'Parking'; }
      else if (lower === 'garden') { type = 'garden'; label = 'Ogródek'; }
      else if (lower === 'lift' || lower === 'elevator') { type = 'lift'; label = 'Winda'; }
      else if (lower === 'cellar' || lower === 'basement') { type = 'cellar'; label = 'Piwnica'; }
      else if (lower === 'internet' || lower === 'wifi') { type = 'internet'; label = 'Internet'; }
      else if (lower === 'tv' || lower === 'television') { type = 'tv'; label = 'TV'; }
      else if (lower === 'ac' || lower === 'air-conditioning') { type = 'ac'; label = 'Klimatyzacja'; }
      else if (lower === 'pets') { type = 'pets'; label = 'Zgoda na zwierzęta'; }
      else if (lower === 'washing-machine') { type = 'washer'; label = 'Pralka'; }
      else if (lower === 'dishwasher') { type = 'dishwasher'; label = 'Zmywarka'; }
      else if (lower === 'fridge') { type = 'fridge'; label = 'Lodówka'; }
      else if (lower === 'oven') { type = 'oven'; label = 'Piekarnik'; }
      // Skip unmapped labels — we don't want to flood the conveniences
      // table with arbitrary strings. The translate pipeline can be
      // extended later if a missing amenity becomes important.
      if (!type) continue;
      if (seen.has(type)) continue;
      seen.add(type);
      conv.push({ type, label });
      if (conv.length >= 12) break; // persistListing cap
    }
    return conv;
  }

  // Strip tracking/marketing query params so the same ad always produces
  // the same stored URL. rentola's listing URLs are clean by default
  // (no utm_* in the /listings/<slug>-p<6-hex> path), but normalizing
  // defensively protects against future regressions and against imported
  // URLs with utm_*/fbclid etc. Mirrors B5 (adresowo), B2-5 (otodom),
  // B3-11 (olx), D1 (nieruchomosci-online), D2 (domiporta), D3 (oferty-
  // net), D5 (tabelaofert), D10 (okolica), D-wynajem24-11 (wynajem24).
  _normalizeUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    try {
      const u = new URL(rawUrl, this.baseUrl);
      const strip = /^(utm_|ref|ref_src|ref_url|fbclid|gclid|gbraid|wbraid|msclkid|mc_|_ga|yclid|ysclk|dclid|cmpid|source|medium|campaign|term|content)/i;
      for (const k of [...u.searchParams.keys()]) {
        if (strip.test(k)) u.searchParams.delete(k);
      }
      const search = u.searchParams.toString();
      return `${u.origin}${u.pathname}${search ? '?' + search : ''}`;
    } catch {
      return rawUrl;
    }
  }
}
