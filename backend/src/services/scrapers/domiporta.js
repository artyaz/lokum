// domiporta.pl scraper — Agora SA portal (sister of Morizon/Gratka via shared
// schema.org Product/RealEstateListing JSON-LD platform). 2 556 Warszawa
// wynajem listings across ~71 pages × 36/page. Plain fetch() works — no
// Cloudflare, no anti-bot, no Playwright fallback needed.
//
// Site layout (verified 2026-08-29 via curl + z-ai page_reader on live pages):
//
//   Search:  https://www.domiporta.pl/mieszkanie/wynajme/<wojewodztwo>/<miasto>?PageNumber=N
//            e.g. https://www.domiporta.pl/mieszkanie/wynajme/mazowieckie/warszawa?PageNumber=2
//            36 listings/page, ~71 pages for Warszawa = 2 556 total listings.
//
//            Search JSON-LD: <script type="application/ld+json">{
//              "@context":"https://schema.org","@graph":[
//                {"@type":"WebPage", ...},
//                {"@type":"ItemList","itemListElement":[
//                  {"@type":"ListItem","position":1,"item":{
//                    "@type":["Product","RealEstateListing"],
//                    "name":"...","description":"...",
//                    "image":"https://galeria.domiporta.pl/pictures/big/...",
//                    "datePosted":"2026-08-20",
//                    "offers":{"@type":"Offer","price":3313.0,"priceCurrency":"PLN",
//                      "priceSpecification":{... per-m² ...},
//                      "itemOffered":{"@type":"Accommodation","numberOfRooms":5,
//                        "floorSize":{"value":98.5},
//                        "address":{"addressLocality":"Warszawa",
//                          "addressRegion":"Mazowieckie","streetAddress":"Konstancińska"}}},
//                    "url":"https://www.domiporta.pl/nieruchomosci/wynajme-.../156759802"
//                  }}
//                ]}
//              ]}
//            }
//            The search card has 1 image only — full gallery comes from the
//            detail page's JSON-LD `image[]` array.
//
//   Detail:  https://www.domiporta.pl/nieruchomosci/wynajme-<slug>/<id>
//            Server-renders TWO identical JSON-LD blocks — one @type=Product,
//            one @type=RealEstateListing. Both have:
//              - name (full title)
//              - description (TRUNCATED with "..." at the end — full text is
//                in <div class="description__panel">)
//              - image[] (5-10 full-res galeria.domiporta.pl URLs — this is
//                the primary photo source; meets the 8-12 minimum on most
//                listings, though some have only 5-7)
//              - datePosted ("2026-08-02")
//              - address.streetAddress, addressLocality, addressRegion
//              - offers.price, offers.priceCurrency (PLN)
//              - itemOffered.geo.latitude/longitude (CRITICAL — must not be null)
//              - itemOffered.floorLevel ("1")
//              - itemOffered.floorSize.value (m² as a Number)
//              - itemOffered.numberOfRooms (OFTEN NULL on detail — falls back
//                to search card's value)
//              - itemOffered.amenityFeature[] (ogrzewanie, umeblowane, ...)
//              - itemOffered.additionalProperty[] (Liczba pięter, Materiał, ...)
//              - seller.name (agency name)
//
//   Description: <div class="description__panel">…full Polish text with <b>...</b>
//                + <br> + <ul><li>...</li></ul>...</div>
//                Followed by a "Rozwiń" expand button + ad-statistics div.
//                We strip tags preserving <br> as newlines and <li> as bullets.
//
// Quality bar (per Task D brief):
//   - lat/lng: JSON-LD itemOffered.geo (must not be null)
//   - photos: JSON-LD image[] (5-10; falls back to single search-card image)
//   - description: full Polish text from <div class="description__panel">
//   - price: PLN/monthly from JSON-LD offers.price
//
// Dedupe overlap (per C2 research): domiporta is owned by Agora SA — same
// parent as Morizon + Gratka. High cross-source overlap expected; the
// services/dedupe.js pipeline catches these via geo + area + rooms fingerprint.
//
// Task 3-c (detail-enrichment gap fix, 2026-09):
//   - ENRICH_LIMIT 300 → 1500 (300 capped the in-scrape enrich ~780 listings
//     short of the ~1 078 collected → 1-photo/no-coords/truncated-desc rows).
//   - Description: prioritized chain panel → JSON-LD → og:description, with
//     markdown ** cleanup + numeric-entity decoding; empty-desc ads (real on
//     the source, e.g. 156760150) keep desc='' and log a distinct line.
//   - Photos: strict big-only markup fallback merged behind JSON-LD image[]
//     (dedupe by 40-hex image hash; NO small/medium→big rewriting — the
//     similar-ads rail lazy-loads /small/ thumbs and that leaked before).
//   - District/street now parsed from the title tail "…: Warszawa Mokotów:
//     Cybernetyki" (JSON-LD addressLocality is only the city).
//   - Shared _enrichmentGaps() diagnostics for both enrich paths.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 9;
// 36 listings/page × 30 pages = ~1 080 listings/city/fetch — ~42% of the
// 2 556-listing Warszawa inventory. Pairs with the 3×/day recommended
// schedule (B8) so each fetch catches every listing added in the past ~8h
// with margin to spare.
const MAX_PAGES = 30;
// Task 3-c: was 300 — the cap left ~780 of ~1 078 listings per Warsaw walk
// un-enriched (1 search-card photo, truncated ~220-char desc, null coords),
// all waiting on the shared post-run enrichBackfill (200/source/cycle →
// ~4 cycles to recover). 1500 covers the full walk (runner's
// RUN_MAX_NEW_LISTINGS cap is 1500 anyway); at 4 workers × 150 ms the extra
// fetches add only ~2-4 min to the run. knownWithImages still skips
// already-enriched repeat listings on subsequent runs.
const ENRICH_LIMIT = 1500;
const ENRICH_CONCURRENCY = 4;
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Pre-fix a single failure did `break` and silently
// dropped pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// domiporta search results return exactly 36 listings/page.
const OFFERS_PER_PAGE = 36;

// City path map — województwo/miasto segments. Domiporta's URL pattern
// requires BOTH segments (the województwo is not optional).
const CITY_PATH = {
  warsaw:  { woj: 'mazowieckie',     miasto: 'warszawa' },
  krakow:  { woj: 'malopolskie',     miasto: 'krakow' },
  wroclaw: { woj: 'dolnoslaskie',    miasto: 'wroclaw' },
  gdansk:  { woj: 'pomorskie',       miasto: 'gdansk' },
  poznan:  { woj: 'wielkopolskie',   miasto: 'poznan' }
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

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
    // Task 3-c: numeric HTML entities (&#x119; &#xB2; &#8211;) — og:description
    // and meta content are entity-encoded while description__panel is not.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Task 3-c: domiporta stores ad text in markdown-ish source form — "**bold**"
// emphasis, "* " bullets, stray asterisks (rendered client-side on the site,
// but present verbatim in description__panel / og:description / JSON-LD).
// Strip the markup chars, keep the text.
function cleanMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\n)[ \t]*\*[ \t]+/g, '$1• ')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Parse a number from a Polish-formatted string ("3 313,00" or "3313.0").
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export class DomiportaScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as gratka/ofertyNet/
  // nieruchomosciOnline. The detail-page enrichment (photos / full
  // description / coords from the detail-page JSON-LD + description__panel)
  // needs to run AFTER the search walk, and the streaming `onListing` path
  // skips enrichment. We retain the listings array (~5 MB for ~1 080 listings
  // × 5 KB payload) and then run the 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'domiporta',
      baseUrl: 'https://www.domiporta.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const path = CITY_PATH[city.slug];
    if (!path) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('DOMIPORTA_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('PageNumber', String(page));
      // Price filter — domiporta uses PriceFrom/PriceTo query params
      // (verified via the search page sidebar filter URLs). We expose them
      // so the runner-level filters translate cleanly.
      if (filters.maxPrice != null) params.set('PriceTo', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('PriceFrom', String(filters.minPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkanie/wynajme/${path.woj}/${path.miasto}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[domiporta] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[domiporta] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip doesn't
        // cascade into a hard abort and skip the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0; // reset on success

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[domiporta] ${city.slug}: no cards on page 1`);
        else console.log(`[domiporta] ${city.slug} page ${page}: empty page — stopping`);
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
        if (onListing) await onListing(card);
        else ads.push(card);
      }
      console.log(
        `[domiporta] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 36 cards each; the true last
      // page returns fewer. Use HALF of OFFERS_PER_PAGE as the threshold so
      // a natural fluctuation of ±1-2 cards doesn't trigger a false break.
      if (cards.length < Math.ceil(OFFERS_PER_PAGE / 2)) {
        console.log(`[domiporta] ${city.slug} page ${page}: short page (${cards.length}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse the search-results JSON-LD. The page emits an `@graph` with two
  // entries: a WebPage and an ItemList. We extract the ItemList's
  // itemListElement[] and normalize each ListItem.item (a Product /
  // RealEstateListing) to a card object.
  //
  // Fallback: if the JSON-LD ItemList is missing (e.g. CF shell — not
  // expected on domiporta but defensive), regex-scan for detail URLs.
  _parseSearchCards(html, city) {
    const out = [];
    const blocks = this._extractJsonLd(html);

    // Find the ItemList block within @graph.
    let items = null;
    for (const b of blocks) {
      const g = b?.['@graph'];
      if (Array.isArray(g)) {
        const il = g.find(e => e?.['@type'] === 'ItemList');
        if (il && Array.isArray(il.itemListElement)) {
          items = il.itemListElement;
          break;
        }
      }
      // Some pages may put the ItemList at the top level.
      if (b?.['@type'] === 'ItemList' && Array.isArray(b.itemListElement)) {
        items = b.itemListElement;
        break;
      }
    }
    if (items) {
      for (const li of items) {
        const item = li?.item || li;
        const card = this._normalizeSearchItem(item, city);
        if (card) out.push(card);
      }
      return out;
    }

    // Fallback: regex-scan for listing detail URLs on the domiporta.pl domain.
    // Each detail URL has the pattern /nieruchomosci/wynajme-.../<digits>
    const re = /https?:\/\/www\.domiporta\.pl\/nieruchomosci\/[a-z0-9-]+\/(\d{6,12})/gi;
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

  // Map one JSON-LD Product/RealEstateListing from the search results to a
  // normalized card object. Mirrors gratka's normalizeOffer but is local
  // because domiporta's shape differs slightly (itemOffered nested inside
  // offers, priceSpecification with per-m² info we don't need).
  _normalizeSearchItem(item, city) {
    if (!item || typeof item !== 'object') return null;
    const url = item.url;
    if (!url) return null;
    const externalId = this._extractIdFromUrl(url);
    if (!externalId) return null;

    const offers = item.offers || {};
    const price = parseNum(offers.price);
    if (!price || price <= 0) return null;

    // itemOffered can live at top-level OR nested inside offers. The detail
    // page nests it inside offers; the search page ALSO nests it inside
    // offers. Handle both.
    const io = offers.itemOffered || item.itemOffered || {};
    const addr = io.address || {};
    const street = addr.streetAddress || null;
    const district = addr.addressLocality || city.name_pl;

    const area = parseNum(io.floorSize?.value != null ? io.floorSize.value : (io.floorSize?.value ?? null));
    const rooms = io.numberOfRooms != null ? parseInt(String(io.numberOfRooms), 10) || null : null;

    // Single thumbnail — full gallery comes from detail-page JSON-LD image[].
    const images = item.image ? (Array.isArray(item.image) ? item.image : [item.image]) : [];

    // Search-card description is truncated with "..." — we still keep it as
    // a fallback; _enrichNew overwrites it with the full text from the
    // detail page's <div class="description__panel">.
    const description = item.description ? String(item.description) : '';

    // datePosted is an ISO date string "2026-08-20" — no time-of-day on the
    // search card. _enrichNew overwrites it from the detail page if present.
    let postedAt = null;
    if (item.datePosted) {
      const d = new Date(String(item.datePosted));
      if (!isNaN(d.getTime())) postedAt = d.toISOString();
    }

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: (item.name ? String(item.name).trim() : null) || `Mieszkanie ${district}`,
      description,
      price: Math.round(price),
      currency: offers.priceCurrency || 'PLN',
      rooms,
      area,
      floor: null, // backfilled from detail-page itemOffered.floorLevel
      district,
      street,
      address: [street, district].filter(Boolean).join(', ') || district,
      lat: null,   // backfilled from detail-page itemOffered.geo
      lng: null,
      url: this._normalizeUrl(url),
      postedAt,
      images,
      conveniences: [],
      raw: { url, searchName: item.name || null }
    };
  }

  // Extract the numeric listing id from a detail URL.
  //   /nieruchomosci/wynajme-mieszkanie-...-rycerska-48m2/156595754 → "156595754"
  _extractIdFromUrl(url) {
    const m = String(url).match(/\/(\d{6,12})(?:[?#]|$)/);
    return m ? m[1] : null;
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full description, lat/lng, full photo gallery,
  // floor, numberOfRooms backfill. Uses the 4-worker Promise pool pattern
  // (ENRICH_CONCURRENCY = 4) from gratka/ofertyNet so we don't pin event-loop
  // memory on a 1 080-listing walk.
  async _enrichNew(ads) {
    if (!ads.length) return;
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
    if (!fresh.length) return;
    console.log(`[domiporta] enriching ${fresh.length} listings (photos/desc/coords)`);

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
          console.warn(`[domiporta] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Post-enrichment diagnostics (same shape as the fetchOneListing
        // path + the otodom/adresowo/morizon fixes — Tasks 4a/4b/4c).
        // Surfaces listings where extraction left gaps so the run log
        // shows which URLs to investigate.
        const gaps = self._enrichmentGaps(ad);
        if (gaps.length) {
          console.warn(`[domiporta] enrichment gap for ${ad.externalId}: ${gaps.join(', ')}`);
        }
        // Polite delay — 150ms between fetches per worker, same as gratka/ofertyNet.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Shared post-enrichment gap diagnostics (Task 3-c): the in-scrape enrich
  // path and fetchOneListing report the SAME gap shape so run logs stay
  // comparable across paths. Returns the gap list (empty = clean listing).
  _enrichmentGaps(ad) {
    const gaps = [];
    const descLen = (ad.description || '').length;
    if (descLen < 50) gaps.push(`desc=${descLen}`);
    if (ad.lat == null || ad.lng == null) gaps.push('coords');
    if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
    return gaps;
  }

  // Per-listing detail-page fetcher used by the post-run enrichBackfill
  // pipeline (services/enrich.js) when a listing is missing coords /
  // description / photos. Mirrors the fetchOneListing contract on
  // otodom / adresowo / gratka / morizon:
  //   - Returns null on fetch failure (caller keeps the existing stub).
  //   - Returns { externalId, sourceId, cityId, title, description, lat,
  //     lng, images, street, ... } with whatever fields it could extract
  //     from the detail page.
  //   - Per-field try/catch + post-enrichment gap diagnostics surface
  //     missing-data patterns in the run log instead of silently persisting
  //     incomplete listings (same pattern as the otodom/adresowo/morizon
  //     fixes — Tasks 4a/4b/4c).
  //
  // The heavy lifting is delegated to the existing `_applyDetail` (which
  // already extracts photos / coords / floor / area / rooms / address /
  // price / title / datePosted / description / conveniences from the detail
  // page's JSON-LD + <div class="description__panel">).
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    const ad = {
      externalId: String(externalId || ''),
      url,
      images: [],
      raw: {},
      description: '',
      lat: null,
      lng: null,
      floor: null,
      area: null,
      rooms: null,
      street: null,
      district: city?.name_pl || null,
      address: null,
      price: 0,
      currency: 'PLN',
      title: null,
      postedAt: null,
      conveniences: []
    };
    let html;
    try {
      html = await this._fetch(url, { desktop: true, timeout: 20000 });
    } catch (e) {
      console.warn(`[domiporta] fetchOneListing fetch failed for ${url}: ${e.message}`);
      return null;
    }
    // _applyDetail has internal per-field try/catch, but guard against any
    // unexpected throw so we still return a stub instead of crashing the
    // caller. Previously the BaseScraper default returned null — making
    // domiporta enrichment a complete no-op (50% missing coords, 7.1 avg
    // photos pre-fix). With this override, the default-case path in
    // enrich.js now produces real data.
    try {
      this._applyDetail(html, ad);
    } catch (e) {
      console.warn(`[domiporta] fetchOneListing: _applyDetail threw for ${url}: ${e.message}`);
    }
    // Post-enrichment diagnostics: surface listings where extraction left
    // gaps so the run log shows which URLs to investigate. Same shape as
    // the adresowo/otodom fixes.
    const gaps = this._enrichmentGaps(ad);
    if (gaps.length) {
      console.warn(`[domiporta] enrichment gap for ${url}: ${gaps.join(', ')}`);
    }
    return {
      externalId: String(externalId || ''),
      sourceId: SOURCE_ID,
      cityId: city?.id,
      title: ad.title || 'Pending enrichment',
      description: ad.description || '',
      price: ad.price || 0,
      currency: ad.currency || 'PLN',
      rooms: ad.rooms ?? null,
      area: ad.area ?? null,
      floor: ad.floor ?? null,
      district: ad.district || city?.name_pl || null,
      street: ad.street || null,
      address: ad.address || null,
      lat: ad.lat ?? null,
      lng: ad.lng ?? null,
      url,
      postedAt: ad.postedAt || null,
      images: ad.images || [],
      conveniences: ad.conveniences || [],
      raw: ad.raw || {}
    };
  }

  // Apply detail-page data to an existing listing object. Fetches:
  //   - JSON-LD block (RealEstateListing OR Product — both are identical)
  //     → photos (image[]), lat/lng (itemOffered.geo), floor (itemOffered.floorLevel),
  //       area (itemOffered.floorSize.value), rooms (itemOffered.numberOfRooms),
  //       street (address.streetAddress), district (address.addressLocality),
  //       price (offers.price), datePosted
  //   - Full Polish description from <div class="description__panel">
  //   - additionalProperty[] → conveniences (Lift, Balkon, etc.)
  //
  // Per-field try/catch (Task 4d): each extraction block is wrapped in its
  // own try/catch with a logged warning. Previously a single broken field
  // (e.g. a malformed geo block on an edge-case listing) would throw and
  // abort ALL subsequent extraction inside the `if (listing)` block —
  // leaving the listing with photos but no coords/desc/etc. Mirrors the
  // hardening applied to otodom (4a) / adresowo (4b) / morizon (4c).
  _applyDetail(html, ad) {
    const s = String(html);
    const logId = ad?.url || ad?.externalId || '?';

    // ---- 1. JSON-LD RealEstateListing/Product block (primary source) ----
    const listing = this._extractListingBlock(s);
    if (listing) {
      // Photos — JSON-LD image[] gives 5-10 full-res galeria URLs.
      try {
        if (Array.isArray(listing.image) && listing.image.length) {
          const photos = [];
          const seen = new Set();
          for (const u of listing.image) {
            if (typeof u !== 'string') continue;
            if (seen.has(u)) continue;
            seen.add(u);
            photos.push(u);
            if (photos.length >= 20) break; // persistListing cap
          }
          if (photos.length) ad.images = photos;
        } else if (typeof listing.image === 'string' && listing.image) {
          // Single image fallback
          if (!ad.images.length) ad.images = [listing.image];
        }
      } catch (e) { console.warn(`[domiporta] photos extract failed for ${logId}: ${e.message}`); }

      const io = listing.itemOffered || {};

      // Coords — MUST not be null per quality bar
      try {
        if (io.geo?.latitude != null && io.geo?.longitude != null) {
          const lat = parseFloat(io.geo.latitude);
          const lng = parseFloat(io.geo.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng) &&
              lat > 40 && lat < 60 && lng > 10 && lng < 30) {
            ad.lat = lat;
            ad.lng = lng;
          }
        }
      } catch (e) { console.warn(`[domiporta] coords extract failed for ${logId}: ${e.message}`); }

      // Floor
      try {
        if (io.floorLevel != null) {
          ad.floor = String(io.floorLevel);
        }
      } catch (e) { console.warn(`[domiporta] floor extract failed for ${logId}: ${e.message}`); }

      // Area (detail-page itemOffered.floorSize.value is the precise m²)
      try {
        if (io.floorSize?.value != null) {
          const a = parseNum(io.floorSize.value);
          if (a != null && a > 0) ad.area = a;
        }
      } catch (e) { console.warn(`[domiporta] area extract failed for ${logId}: ${e.message}`); }

      // Rooms — detail page often has numberOfRooms as null; only overwrite
      // the search-card value if the detail page actually has it.
      try {
        if (io.numberOfRooms != null) {
          const r = parseInt(String(io.numberOfRooms), 10);
          if (!isNaN(r) && r > 0) ad.rooms = r;
        }
      } catch (e) { console.warn(`[domiporta] rooms extract failed for ${logId}: ${e.message}`); }

      // Address — prefer detail's street/district over search card's
      try {
        const addr = listing.address;
        if (addr) {
          if (addr.streetAddress) ad.street = String(addr.streetAddress);
          if (addr.addressLocality) ad.district = String(addr.addressLocality);
          ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;
        }
      } catch (e) { console.warn(`[domiporta] address extract failed for ${logId}: ${e.message}`); }

      // Price — sanity-check (detail price should match search card)
      try {
        if (listing.offers?.price != null) {
          const p = Math.round(parseNum(listing.offers.price));
          if (p > 0 && (!ad.price || Math.abs(p - ad.price) > Math.max(50, ad.price * 0.05))) {
            ad.price = p;
          }
        }
      } catch (e) { console.warn(`[domiporta] price extract failed for ${logId}: ${e.message}`); }

      // Currency
      try {
        if (listing.offers?.priceCurrency) {
          ad.currency = String(listing.offers.priceCurrency);
        }
      } catch (e) { console.warn(`[domiporta] currency extract failed for ${logId}: ${e.message}`); }

      // Title (detail page has full title — search card has same actually)
      try {
        if (listing.name) {
          ad.title = String(listing.name).trim();
        }
        // Task 3-c: refine district/street from the universal title tail
        // "…: Warszawa Mokotów: Cybernetyki". JSON-LD addressLocality is only
        // the CITY ("Warszawa") — the real dzielnica lives in the title, and
        // the app's district filter + coord fallback need the district, not
        // the city. Only overrides the city-level value; keeps JSON-LD street
        // when present.
        const inferred = this._inferDistrictFromTitle(ad.title, ad.district);
        if (inferred?.district) {
          ad.district = inferred.district;
          if (inferred.street && !ad.street) ad.street = inferred.street;
          ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;
        }
      } catch (e) { console.warn(`[domiporta] title extract failed for ${logId}: ${e.message}`); }

      // Rooms fallback — many domiporta detail pages omit numberOfRooms
      // from JSON-LD (the search card has it, but if the ad was created
      // without that field we'd be left with null). Infer from title/slug:
      //   "kawalerka" → 1, "jednopokojowe" → 1, "dwupokojowe" → 2,
      //   "trzypokojowe" → 3, "czteropokojowe" → 4, "pięciopokojowe" → 5
      try {
        if (ad.rooms == null) {
          ad.rooms = this._inferRoomsFromTitle(ad.title || listing.name || '');
        }
      } catch (e) { console.warn(`[domiporta] rooms-infer failed for ${logId}: ${e.message}`); }

      // datePosted — ISO date "2026-08-02"
      try {
        if (listing.datePosted) {
          const d = new Date(String(listing.datePosted));
          if (!isNaN(d.getTime())) ad.postedAt = d.toISOString();
        }
      } catch (e) { console.warn(`[domiporta] postedAt extract failed for ${logId}: ${e.message}`); }

      // Conveniences — derive from amenityFeature[] + additionalProperty[]
      try {
        if (!ad.conveniences || !ad.conveniences.length) {
          ad.conveniences = this._inferConveniences(io);
        }
      } catch (e) { console.warn(`[domiporta] conveniences extract failed for ${logId}: ${e.message}`); }

      // Raw extras (yearBuilt, building type) — saved for translate pipeline
      try {
        if (io.additionalProperty && Array.isArray(io.additionalProperty)) {
          const params = io.additionalProperty
            .filter(p => p && p.name && p.value != null)
            .map(p => ({ key: String(p.name), name: String(p.name), value: String(p.value) }))
            .slice(0, 20);
          if (params.length) {
            ad.raw = ad.raw || {};
            ad.raw.params = params;
          }
        }
      } catch (e) { console.warn(`[domiporta] additionalProperty extract failed for ${logId}: ${e.message}`); }
    }

    // ---- 1b. Gallery fallback (Task 3-c) ----
    // JSON-LD image[] is the primary gallery and matches the ad's slider 1:1
    // (verified live: unique big-size URLs == JSON-LD image[] length), but
    // this big-only markup scan covers pages whose JSON-LD block is missing
    // or unparseable. It cannot leak other ads' photos: the similar-ads rail
    // lazy-loads /pictures/small/ thumbs, /pictures/big/ is only emitted for
    // this ad's own gallery + og:image. Merge (JSON-LD order wins), don't
    // replace, so the proven primary path is never perturbed.
    try {
      const extra = this._extractGalleryPhotos(s);
      if (extra.length) {
        const merged = this._mergePhotos(ad.images || [], extra);
        if (merged.length > (ad.images || []).length) ad.images = merged;
      }
    } catch (e) { console.warn(`[domiporta] gallery-fallback extract failed for ${logId}: ${e.message}`); }

    // ---- 2. Full Polish description (Task 3-c prioritized chain) ----
    // 1. <div class="description__panel"> — full text (primary).
    // 2. JSON-LD description — truncated (~200-300 chars, ends "…") but real
    //    text when the panel div is absent from the page variant.
    // 3. <meta property="og:description"> — markdown-flavored, near-full.
    // Ads with NO text anywhere (verified live on 156760150: JSON-LD desc="",
    // empty og:description, no panel div — the description column holds only
    // the ad-statistics block) keep desc='' — handled gracefully, no failure.
    try {
      const { text, source } = this._extractDescription(s, listing);
      if (text && text.length > (ad.description || '').length) {
        ad.description = text;
        if (source === 'jsonld' || source === 'og') {
          console.log(`[domiporta] description from ${source} fallback for ${logId} (${text.length} chars — panel div missing)`);
        }
      } else if (!ad.description || ad.description.length < 10) {
        ad.description = '';
        console.log(`[domiporta] no description on source page for ${logId} (ad genuinely has none)`);
      }
    } catch (e) { console.warn(`[domiporta] description extract failed for ${logId}: ${e.message}`); }
  }

  // Infer the number of rooms from a Polish listing title or URL slug.
  // Domiporta titles use the forms:
  //   "kawalerka"            → 1 room
  //   "jednopokojowe"        → 1 room
  //   "dwupokojowe"          → 2 rooms
  //   "trzypokojowe"         → 3 rooms
  //   "czteropokojowe"       → 4 rooms
  //   "pięciopokojowe"       → 5 rooms
  //   "X-pokojowe" / "X pokoje" / "X pokoi" → X rooms
  // Returns null if no match. Used as a fallback when the JSON-LD
  // numberOfRooms field is missing on detail pages.
  _inferRoomsFromTitle(text) {
    if (!text) return null;
    // Normalize Polish accents: kawalerkę → kawalerke, dwupokojową → dwupokojowa
    // so a single regex per word-form catches all inflections.
    const s = String(text).toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (/kawalerka|kawalerek|kawalerk[ae]/.test(s)) return 1;
    if (/jednopokojowe|jednopokojowa|1-pokojowe|1-pokojowa|1 pokojowe|1 pokoje/.test(s)) return 1;
    if (/dwupokojowe|dwupokojowa|2-pokojowe|2-pokojowa|2 pokoje|2 pokoi|2-pokoje/.test(s)) return 2;
    if (/trzypokojowe|trzypokojowa|3-pokojowe|3-pokojowa|3 pokoje|3 pokoi/.test(s)) return 3;
    if (/czteropokojowe|czteropokojowa|4-pokojowe|4-pokojowa|4 pokoje|4 pokoi/.test(s)) return 4;
    if (/pieciopokojowe|5-pokojowe|5-pokojowa|5 pokoje|5 pokoi/.test(s)) return 5;
    if (/szesciopokojowe|6-pokojowe|6-pokojowa|6 pokoje|6 pokoi/.test(s)) return 6;
    // Generic fallback: "N pokojowe" or "N-pokojowe" or "N pokoje"
    const m = s.match(/(\d+)\s*-?\s*pokojowe|\b(\d+)\s+(?:pokoje|pokoi)\b/);
    if (m) {
      const n = parseInt(m[1] || m[2], 10);
      if (!isNaN(n) && n > 0 && n < 20) return n;
    }
    return null;
  }

  // Find the JSON-LD block whose @type is RealEstateListing OR Product on a
  // detail page. Domiporta emits BOTH — they're identical content-wise, so we
  // grab whichever comes first.
  _extractListingBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      const t = b?.['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes('RealEstateListing') || types.includes('Product')) {
        // Must have an `offers` block to be a real listing (weeds out generic
        // Product blocks for the site's own metadata, like og-image schema).
        if (b?.offers && (b.offers.price != null || b.url)) return b;
      }
    }
    return null;
  }

  // Extract the full Polish description from <div class="description__panel">.
  // The JSON-LD `description` field is TRUNCATED — the full text is here.
  // We capture the div's inner HTML, then strip tags preserving <br> as
  // newlines and <li> as bullet lines.
  //
  // Task 3-c: boundary variants tried in order — some page variants close the
  // panel with </section> or nest a </div> before the Rozwiń button, and the
  // old single regex + first-</div> fallback truncated such panels.
  _extractFullDescription(html) {
    const s = String(html);
    const open = s.match(/<div[^>]*class="[^"]*description__panel[^"]*"[^>]*>/i);
    if (!open) return null;
    const start = open.index + open[0].length;
    const rest = s.slice(start);
    const patterns = [
      /^([\s\S]*?)<\/div>\s*<button/i,   // panel → "Rozwiń" button (classic)
      /^([\s\S]*?)<\/div>\s*<\/section>/i,
      /^([\s\S]*?)<\/section>/i,
      /^([\s\S]*?)<\/div>/i               // last resort: first closing div
    ];
    for (const re of patterns) {
      const m = rest.match(re);
      if (m && m[1].trim()) return stripTags(m[1]);
    }
    return null;
  }

  // Task 3-c: prioritized description extraction, SHARED by the in-scrape
  // enrich path (_enrichNew → _applyDetail) and fetchOneListing (enrich.js
  // backfill) — both call _applyDetail, so both get every fallback.
  //   1. description__panel div (full text)
  //   2. JSON-LD description (truncated ~200-300 chars, but real text)
  //   3. og:description meta (markdown-flavored, near-full, entity-encoded)
  // Returns { text, source } — source ∈ panel|jsonld|og|short|none.
  _extractDescription(html, listing) {
    const s = String(html);
    const panel = this._extractFullDescription(s);
    if (panel && panel.length >= 50) return { text: cleanMarkdown(panel), source: 'panel' };
    const jld = listing?.description ? String(listing.description) : '';
    if (jld && jld.length >= 50) return { text: cleanMarkdown(jld), source: 'jsonld' };
    const og = s.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
               s.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
    const ogText = og && og[1] ? cleanMarkdown(stripTags(og[1])) : '';
    if (ogText.length >= 50) return { text: ogText, source: 'og' };
    // No rich source — keep the longest short text we have rather than nothing.
    const best = [cleanMarkdown(panel || ''), cleanMarkdown(jld || ''), ogText]
      .sort((a, b) => b.length - a.length)[0] || '';
    return { text: best, source: best ? 'short' : 'none' };
  }

  // Task 3-c: gallery fallback — collect THIS ad's photos from the detail
  // page markup when the JSON-LD image[] is missing or unparseable:
  //   - every /pictures/big/ URL (og:image, <link itemprop="image">, slider
  //     <img src>/srcset/data-lazy — the ad's own gallery is always emitted
  //     in big/), plus
  //   - <meta property="og:image"> as the last resort.
  // STRICT big-only: the similar-ads rail lazy-loads /pictures/small/ thumbs
  // via data-lazy (verified live 2026-09 — normalizing small→big leaked 10
  // other ads' photos into a 1-photo listing's gallery), so non-big URLs are
  // rejected and NO size rewriting happens. Dedupes by the 40-hex image hash
  // (jpg/webp of one photo share it). Returns [] when nothing found.
  _extractGalleryPhotos(html) {
    const s = String(html);
    const out = [];
    const seenHash = new Set();
    const push = (raw) => {
      const u = String(raw || '').trim();
      if (!/^https:\/\/galeria\.domiporta\.pl\/pictures\/big\//i.test(u)) return;
      if (!/\.jpe?g$/i.test(u)) return; // webp duplicates the jpg of the same hash
      const hm = u.match(/\/pictures\/big\/(?:[0-9a-f]{2}\/){3}([0-9a-f]{16,64})\//i);
      const key = hm ? hm[1].toLowerCase() : u;
      if (seenHash.has(key)) return;
      seenHash.add(key);
      out.push(u);
    };
    let m;
    const reBig = /https:\/\/galeria\.domiporta\.pl\/pictures\/big\/[^"'\s<>\\)]+\.jpe?g/gi;
    while ((m = reBig.exec(s)) !== null) push(m[0]);
    const og = s.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)['"]/i) ||
               s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image['"]/i);
    if (og) push(og[1]);
    return out.slice(0, 20);
  }

  // Task 3-c: merge JSON-LD photos with markup-extracted extras. JSON-LD
  // order wins (it is the ad's canonical gallery order), extras appended,
  // dedupe by image hash, cap at the persistListing 20-image limit.
  _mergePhotos(primary, extras) {
    const seen = new Set();
    const keyOf = (u) => {
      const hm = String(u).match(/\/pictures\/[a-z]+\/(?:[0-9a-f]{2}\/){3}([0-9a-f]{16,64})\//i);
      return hm ? hm[1].toLowerCase() : String(u).replace(/\/pictures\/[a-z]+\//, '');
    };
    const out = [];
    for (const u of [...(primary || []), ...(extras || [])]) {
      if (!u || typeof u !== 'string') continue;
      const k = keyOf(u);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
      if (out.length >= 20) break;
    }
    return out;
  }

  // Task 3-c: extract the real district (dzielnica) + street from the
  // universal domiporta title tail "…: <City> <District>: <Street>":
  //   "…mieszkania na Mokotowie: Warszawa Mokotów: Cybernetyki"
  //     → { district: 'Mokotów', street: 'Cybernetyki' }
  // Multi-word districts work ("Żoliborz Marymont-Potok", "Praga-Południe",
  // "Białołęka" — verified across live listings 2026-09). Returns null when
  // the tail is absent or the district equals the city name.
  _inferDistrictFromTitle(title, city) {
    if (!title) return null;
    const m = String(title).match(/:\s*([^:]+):\s*([^:]+)\s*$/);
    if (!m) return null;
    const mid = m[1].trim();
    const street = m[2].trim() || null;
    const loc = String(city || '').trim();
    let district = null;
    if (loc && mid.toLowerCase().startsWith(loc.toLowerCase() + ' ')) {
      district = mid.slice(loc.length).trim();
    } else if (!loc) {
      const w = mid.match(/^\S+\s+(.+)$/); // "Warszawa Mokotów" → "Mokotów"
      if (w) district = w[1].trim();
    }
    if (!district || district.toLowerCase() === loc.toLowerCase()) return null;
    return { district, street };
  }

  // Infer conveniences from JSON-LD amenityFeature[] + additionalProperty[].
  // Polish labels mirror the convention used by adresowo/gratka.
  _inferConveniences(io) {
    const conv = [];
    if (!io) return conv;
    const feats = io.amenityFeature || [];
    const props = io.additionalProperty || [];

    const hasAmenity = (name) => {
      for (const f of feats) {
        if (String(f?.name || '').toLowerCase().includes(name) && f.value === true) return true;
      }
      return false;
    };
    const getProp = (name) => {
      for (const p of props) {
        const pn = String(p?.name || '').toLowerCase();
        if (pn.includes(name)) return p?.value;
      }
      return null;
    };

    if (hasAmenity('umeblowane') || hasAmenity('meble')) conv.push({ type: 'furniture', label: 'Umeblowane' });
    if (hasAmenity('balkon')) conv.push({ type: 'balcony', label: 'Balkon' });
    if (hasAmenity('taras')) conv.push({ type: 'balcony', label: 'Taras' });
    if (hasAmenity('garaz') || hasAmenity('garaż')) conv.push({ type: 'garage', label: 'Garaż' });
    if (hasAmenity('ogrod') || hasAmenity('ogródek') || hasAmenity('ogród')) {
      conv.push({ type: 'garden', label: 'Ogródek' });
    }
    if (hasAmenity('parking')) conv.push({ type: 'park', label: 'Parking' });
    if (hasAmenity('winda') || hasAmenity('wind')) conv.push({ type: 'lift', label: 'Winda' });
    if (hasAmenity('piwnica') || hasAmenity('komorka')) conv.push({ type: 'cellar', label: 'Piwnica' });

    // additionalProperty — building type / heating type
    const liftProp = getProp('winda');
    if (liftProp && /tak|istnieje/i.test(String(liftProp))) {
      if (!conv.some(c => c.type === 'lift')) conv.push({ type: 'lift', label: 'Winda' });
    }
    const parkingProp = getProp('miejsce parkingowe');
    if (parkingProp && /tak|tak/i.test(String(parkingProp))) {
      if (!conv.some(c => c.type === 'park')) conv.push({ type: 'park', label: 'Miejsce parkingowe' });
    }

    // Dedupe by type (e.g. taras + balkon collapse to balcony)
    const seen = new Set();
    const out = [];
    for (const c of conv) {
      if (seen.has(c.type)) continue;
      seen.add(c.type);
      out.push(c);
    }
    return out.slice(0, 12);
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Domiporta's listing URLs are clean by default, but
  // normalizing defensively protects against future regressions and against
  // imported URLs with utm_*/fbclid etc. Mirrors B5 (adresowo), B2-5 (otodom),
  // B3-11 (olx), D1 (nieruchomosci-online), D3 (oferty-net).
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
