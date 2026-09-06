// tabelaofert.pl scraper — PropertyGroup Sp. z o.o. sister site of gethome.pl
// (ex-RynekPierwotny). Direct-from-owner rental inventory via the
// `?klient_typ=osoba_prywatna` URL filter. Plain fetch() works — no
// Cloudflare, no anti-bot, no Playwright fallback needed.
//
// Site layout (verified 2026-08-30 via curl + z-ai page_reader on live pages):
//
//   Search:  https://tabelaofert.pl/wynajem/mieszkania/<miasto>?klient_typ=osoba_prywatna&page=N
//            e.g. https://tabelaofert.pl/wynajem/mieszkania/warszawa?klient_typ=osoba_prywatna&page=2
//            30 listings/page; Warszawa yields ~7 pages of owner-direct rent
//            (210-240 listings). The `page=N` param is mandatory from page 2
//            onward — page 1 omits it.
//
//            Search JSON-LD: ONE <script type="application/ld+json"> block with:
//              {"@context":"https://schema.org","@type":"Product",
//               "additionalType":"RealEstateListing",
//               "name":"Mieszkania bez pośredników Warszawa wynajem",
//               "url":"https://tabelaofert.pl/wynajem/mieszkania/warszawa?klient_typ=osoba_prywatna",
//               "offers":{"@type":"AggregateOffer","priceCurrency":"PLN",
//                 "offers":[
//                   {"@type":"Offer","availability":"...InStock",
//                    "name":"Mieszkanie do wynajęcia, 36,00 m², 2 pokoje, 1 piętro, oferta nr ...",
//                    "description":"Oferuję od zaraz mieszkanie do wynajęcia na Woli...st",   // TRUNCATED with "..."
//                    "price":"2 500 zł",          // Polish-formatted string with \u00a0 separator + " zł" suffix
//                    "priceCurrency":"PLN",
//                    "url":"https://tabelaofert.pl/oferta/mieszkanie-...-warszawa-wola,10499808",
//                    "itemOffered":{
//                      "@type":"Accommodation",
//                      "numberOfRooms":{"@type":"QuantitativeValue","value":2},
//                      "floorSize":{"@type":"QuantitativeValue","unitCode":"MTR","value":"36.00"},
//                      "floorLevel":"1",          // string! "0" = parter
//                      "address":{"@type":"PostalAddress",
//                        "addressLocality":"Warszawa, Wola",      // "City, District"
//                        "addressCountry":"PL","addressRegion":"mazowieckie",
//                        "streetAddress":"Myśliborska"},          // often missing
//                      "geo":{"@type":"GeoCoordinates",
//                        "longitude":"20.953610","latitude":"52.233620"},    // STRINGS not numbers!
//                      "additionalProperty":[
//                        {"@type":"PropertyValue","name":"Winda","value":"nie"},
//                        {"@type":"PropertyValue","name":"Termin oddania","value":""}
//                      ]
//                   }}
//                 ]}
//              }
//
//            CRITICAL: the search JSON-LD `offers.offers[]` array has EVERYTHING
//            we need per card (price, rooms, area, floor, address, geo, partial
//            description, full URL). NO detail fetch needed for the search-walk
//            stage — only for full-text description + gallery enrichment.
//
//   Detail:  https://tabelaofert.pl/oferta/<slug>,<id>
//            e.g. https://tabelaofert.pl/oferta/mieszkanie-dwupokojowe-do-wynajecia-zawiszy-warszawa-wola,10497928
//            Server-renders:
//              - ONE JSON-LD block: {"@type":"Product","additionalType":"Offer",
//                "name":"...","description":"<SHORT summary 130 chars>","image":"<single thumb>",
//                "brand":{"name":"Oferta bezpośrednia"},     ← confirms direct-from-owner
//                "offers":{"@type":"Offer","price":0,...,"itemOffered":{...}}
//                  Note: detail-page offers.price is OFTEN 0 — use the search price!
//                "additionalProperty":[{"name":"Typ budynku","value":"apartamentowiec"},
//                                       {"name":"Powierzchnie zewnętrzne","value":"balkon"}, ...]}
//              - Full Polish description lives in
//                <div class="t_Xw38Rb"><div class="t_1HMhyB">…text with <br>…</div></div>
//                The truncated JSON-LD description is the first 303 chars; the
//                div has the full 700-2500 char agent text (with literal <br> tags).
//              - Full photo gallery: <img src="https://content.tabelaofert.pl/<variant>,100642-/import/<slug>-NN.webp">
//                Pattern is per-photo: hero (quality_80,scale_792, prefix), gallery
//                thumbs (quality_80,scale_245, prefix), carousel thumbs (thumb_470x0,
//                prefix), and ORIGINALS (just the agency id prefix "100642-").
//                We dedupe by decoded (variant-stripped) URL and prefer the original.
//
//   Photos:  Gallery URLs follow the pattern
//              https://content.tabelaofert.pl/<variant_prefix>,<agency_id>-/import/<slug>-<NN>.webp
//            where NN is a zero-padded sequence (00, 01, 02, …). The bare
//            `<agency_id>-/import/<slug>-NN.webp` (no variant prefix) is the
//            original photo. We strip variant prefixes and dedupe by the
//            resulting canonical URL. Filter out `/no_person.png` (agent avatar)
//            and `no-photo.webp` (placeholder for no-photo listings).
//
// Quality bar (per Task D brief):
//   - lat/lng: JSON-LD itemOffered.geo (search page) — must not be null
//   - photos: <img src="https://content.tabelaofert.pl/.../import/...-NN.webp"> on detail page
//     (target 8-12; direct-from-owner listings often have 0-5; we extract what's there)
//   - description: full Polish text from <div class="t_1HMhyB">
//   - price: PLN/monthly from search JSON-LD `offers.offers[].price`
//     (NOT from detail page — its offers.price is often 0)
//
// Dedupe overlap (per C2 research): tabelaofert.pl is owned by PropertyGroup
// Sp. z o.o., the same parent as gethome.pl. Some cross-source overlap expected
// with olx/otodom direct-from-owner listings; the services/dedupe.js pipeline
// catches these via geo + area + rooms fingerprint.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 12;
// 30 listings/page × 30 pages = ~900 listings/city/fetch — well above the
// ~210-240 Warszawa owner-direct rent inventory, so MAX_PAGES=30 lets the
// walk hit the true last page (where `cards.length < OFFERS_PER_PAGE / 2`)
// and stop naturally. Pairs with the 3×/day recommended schedule (B8).
const MAX_PAGES = 30;
// Page caps: 30 listings/page. The true last page returns 16 (verified on
// /wynajem/mieszkania/warszawa?klient_typ=osoba_prywatna&page=7). Threshold
// of HALF (=15) is well below the natural ±1-2 fluctuation so a single
// delisted listing doesn't trigger a false break.
const OFFERS_PER_PAGE = 30;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Pre-fix a single failure did `break` and silently
// dropped pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// Cap the number of detail-page fetches per cycle. With ~210-240 owner-direct
// rent listings per walk and 4-worker pool, this caps at ~240 detail fetches
// per cycle — roughly 2-3 minutes at 500ms/fetch. Aligned with gratka's /
// ofertyNet's ENRICH_LIMIT.
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value
// as gratka/morizon/adresowo/domiporta/ofertyNet for parity — 4 workers
// strikes the right balance between throughput and not hammering the source.
const ENRICH_CONCURRENCY = 4;

// City path map — lowercase city slug as it appears in the URL.
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

// Polish number parsing: "2 500 zł" (non-breaking-space thousand separator +
// " zł" suffix), "50,00" (decimal comma). Returns a Number (or null on
// failure). Mirrors ofertyNet.js's parseNum but also strips the trailing
// "zł" / "PLN" currency marker tabelaofert.pl emits inside the JSON-LD
// `price` string.
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const t = String(s)
    .replace(/\u00a0/g, ' ')
    .replace(/\s/g, '')
    .replace(/zł|PLN/gi, '')
    .replace(',', '.')
    .trim();
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// Strip HTML tags from a description HTML fragment while preserving line
// breaks. <br> → newline, </p>/</li> → newline, <li> → bullet. Mirrors
// domiporta.js's stripTags but lives locally because tabelaofert.pl wraps
// the description in literal <br> tags inside a div (no <ul>/<li> wrapping).
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
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

// Normalize a content.tabelaofert.pl image URL to its "original" form by
// stripping the variant prefix (`quality_80,scale_792,100642-` → `100642-`).
// Pattern: https://content.tabelaofert.pl/<variant?>,<agency_id>-/import/<slug>-NN.webp
// We keep only the agency-id + path part, dropping the variant so multiple
// references (thumb, hero, original) collapse to one canonical URL when
// deduping. Returns null for non-image URLs (no_person.png, no-photo.webp).
function canonicalPhotoUrl(url) {
  if (!url) return null;
  let s = String(url).trim();
  // Strip trailing backslash (some URLs are JSON-escaped inside the React
  // Server Components payload and pick up a stray `\` after the closing quote).
  if (s.endsWith('\\')) s = s.slice(0, -1);
  // Must be a content.tabelaofert.pl URL or skip.
  if (!/^https:\/\/content\.tabelaofert\.pl\//i.test(s)) return null;
  // Filter out agent-avatar placeholders and no-photo stand-ins.
  if (/\/no_person\./i.test(s) || /no-photo\./i.test(s)) return null;
  // Strip the optional variant prefix. The path's first segment is either:
  //   <variant>,<variant>,...<agency_id>-   (e.g. quality_80,scale_792,100642-)
  //   <agency_id>-                            (e.g. 100642-)
  // We keep only the agency_id + the rest of the path. The non-greedy
  // `[^/]+?,` matches the variant prefix up to (and including) the LAST comma
  // before the agency id, so `(\d+-/import/...)` captures the full agency id
  // (NOT just its last digit — which a greedy `[^/]*` would do via backtracking).
  const m = s.match(/^(https:\/\/content\.tabelaofert\.pl\/)(?:[^/]+?,)?(\d+-\/import\/[^?#]+)$/i);
  if (m) return m[1] + m[2];
  // If no match (unexpected URL shape), keep as-is and let the caller dedupe.
  return s;
}

// "Data dodania: 2026-08-27" (ISO date on detail page's params list) → ISO
// string at midnight UTC. Returns null if no parseable date is found.
function parsePostedAt(text) {
  if (!text) return null;
  const t = String(text).trim();
  // ISO date "2026-08-27"
  const m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export class TabelaofertScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as gratka/ofertyNet/
  // nieruchomosciOnline/domiporta. The detail-page enrichment (full
  // description / full gallery / additionalProperty → conveniences) needs
  // to run AFTER the search walk, and the streaming `onListing` path
  // skips enrichment. We retain the listings array (~3 MB for ~240
  // listings × 12 KB payload) and then run the 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'tabelaofert',
      baseUrl: 'https://tabelaofert.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('TABELAOFERT_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      // Always set the owner-direct filter — without it, agency listings
      // pollute the feed (C1 + C2 research).
      params.set('klient_typ', 'osoba_prywatna');
      if (page > 1) params.set('page', String(page));
      // Price filter — tabelaofert.pl exposes `cena_od` / `cena_do` query
      // params in its sidebar; we forward the runner-level filters through.
      if (filters.maxPrice != null) params.set('cena_do', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('cena_od', String(filters.minPrice));
      const url = `${this.baseUrl}/wynajem/mieszkania/${cityPath}?${params.toString()}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[tabelaofert] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[tabelaofert] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip doesn't
        // cascade into a hard abort and skip the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0; // reset on success

      const cards = this._parseCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[tabelaofert] ${city.slug}: no cards on page 1`);
        else console.log(`[tabelaofert] ${city.slug} page ${page}: empty page — stopping`);
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
        `[tabelaofert] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 30 cards each (OFFERS_PER_PAGE);
      // the true last page returns ~16 (verified on page 7 for Warszawa).
      // Use HALF of OFFERS_PER_PAGE as the threshold so a natural fluctuation
      // of ±1-2 cards doesn't trigger a false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[tabelaofert] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse the search-results JSON-LD. The page emits ONE Product/
  // RealEstateListing block (when filtered with `klient_typ=osoba_prywatna`)
  // OR a FAQPage + Product pair (when unfiltered). We iterate all JSON-LD
  // blocks and pick the Product one.
  //
  // Fallback: if no JSON-LD Product block is found (defensive — should never
  // happen on a live 200, but protects against transient CF shells), regex-
  // scan for detail URLs in the page's HTML and produce minimal cards.
  _parseCards(html, city) {
    const out = [];
    const blocks = this._extractJsonLd(html);
    let productBlock = null;
    for (const b of blocks) {
      if (b && b['@type'] === 'Product' && Array.isArray(b?.offers?.offers)) {
        productBlock = b;
        break;
      }
    }
    if (productBlock) {
      for (const offer of productBlock.offers.offers) {
        const card = this._normalizeSearchOffer(offer, city);
        if (card) out.push(card);
      }
      return out;
    }

    // Fallback: regex-scan for listing detail URLs on the tabelaofert.pl domain.
    // Each detail URL has the pattern /oferta/mieszkanie-...-warszawa-...,<digits>
    const re = /https?:\/\/tabelaofert\.pl\/oferta\/[a-z0-9-]+,(\d{4,12})/gi;
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

  // Map one JSON-LD Offer (from the search page's AggregateOffer.offers[])
  // to a normalized card object. The offer has rich data — full price,
  // rooms (as QuantitativeValue), area (as QuantitativeValue), floor,
  // address (PostalAddress), geo (GeoCoordinates with lat/lng as strings),
  // additionalProperty (Winda / Termin oddania), and a partial description.
  _normalizeSearchOffer(offer, city) {
    if (!offer || typeof offer !== 'object') return null;
    const url = offer.url;
    if (!url) return null;
    const externalId = this._extractIdFromUrl(url);
    if (!externalId) return null;

    const price = parseNum(offer.price);
    if (!price || price <= 0) return null;

    const io = offer.itemOffered || {};
    const addr = io.address || {};
    const geo = io.geo || {};

    // Coords — MUST not be null per quality bar. The site stores them as
    // STRINGS (e.g. "52.233620"); parseFloat handles the conversion.
    let lat = null, lng = null;
    if (geo.latitude != null && geo.longitude != null) {
      const la = parseFloat(geo.latitude);
      const lo = parseFloat(geo.longitude);
      if (Number.isFinite(la) && Number.isFinite(lo) &&
          la > 40 && la < 60 && lo > 10 && lo < 30) {
        lat = la;
        lng = lo;
      }
    }

    // numberOfRooms can be either a Number or {value: N}.
    let rooms = null;
    if (io.numberOfRooms != null) {
      if (typeof io.numberOfRooms === 'object') rooms = parseInt(String(io.numberOfRooms.value), 10) || null;
      else rooms = parseInt(String(io.numberOfRooms), 10) || null;
    }
    // floorSize — same: either Number or {value: "36.00"}.
    let area = null;
    if (io.floorSize != null) {
      const v = typeof io.floorSize === 'object' ? io.floorSize.value : io.floorSize;
      const a = parseNum(v);
      if (a != null && a > 0) area = a;
    }

    // floorLevel is a string ("0" = parter, "1".."10").
    let floor = null;
    if (io.floorLevel != null) {
      floor = String(io.floorLevel);
    }

    // addressLocality is "Warszawa, Wola" — split to {city, district}.
    // Some listings have just "Warszawa" (no district) — leave district as null.
    let district = null;
    let cityFromAddr = null;
    if (addr.addressLocality) {
      const parts = String(addr.addressLocality).split(/\s*,\s*/).map(s => s.trim());
      if (parts.length >= 2) {
        cityFromAddr = parts[0];
        district = parts.slice(1).join(', ');
      } else {
        cityFromAddr = parts[0] || null;
      }
    }
    const street = addr.streetAddress || null;

    // The search JSON-LD `description` is TRUNCATED with "..." — we still
    // keep it as a fallback; _enrichNew overwrites it with the full text
    // from the detail page's <div class="t_1HMhyB">.
    const description = offer.description ? String(offer.description) : '';

    // Title — use the offer's `name` ("Mieszkanie do wynajęcia, 36,00 m²,
    // 2 pokoje, 1 piętro, oferta nr 3529/3186/OMW") verbatim.
    const title = offer.name ? String(offer.name).trim() : `Mieszkanie na wynajem — ${district || city.name_pl}`;

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title,
      description,
      price: Math.round(price),
      currency: offer.priceCurrency || 'PLN',
      rooms,
      area,
      floor,
      district,
      street,
      address: [street, district].filter(Boolean).join(', ') || district || city.name_pl,
      lat,
      lng,
      url: this._normalizeUrl(url),
      postedAt: null, // backfilled from detail page's "Data dodania"
      images: [],
      conveniences: [],
      raw: {
        url,
        searchName: offer.name || null,
        additionalProperty: io.additionalProperty || []
      }
    };
  }

  // Extract the numeric listing id from a detail URL.
  //   /oferta/mieszkanie-dwupokojowe-...-warszawa-wola,10499808 → "10499808"
  _extractIdFromUrl(url) {
    const m = String(url).match(/,(\d{4,12})(?:[?#]|$)/);
    return m ? m[1] : null;
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full description, full photo gallery,
  // additionalProperty (→ conveniences + raw.params), brand (→ direct marker),
  // and postedAt from "Data dodania". Uses the 4-worker Promise pool pattern
  // (ENRICH_CONCURRENCY = 4) from gratka/ofertyNet/domiporta so we don't pin
  // event-loop memory on a 240-listing walk.
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
    console.log(`[tabelaofert] enriching ${fresh.length} listings (desc/photos/params)`);

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
          console.warn(`[tabelaofert] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as gratka/ofertyNet/domiporta.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Fetches:
  //   - Full Polish description from <div class="t_1HMhyB">
  //   - Full photo gallery from <img src="https://content.tabelaofert.pl/...">
  //   - additionalProperty[] (Typ budynku, balkon, winda, ogrzewanie, rok budowy)
  //     → raw.params + conveniences (Lift, Balcony, …)
  //   - brand.name ("Oferta bezpośrednia" → direct convenience marker)
  //   - postedAt — from "Data dodania: YYYY-MM-DD" on the params list
  //
  // IMPORTANT: the detail page's JSON-LD `offers.price` is OFTEN 0 — we do
  // NOT trust it. The search-card price (parsed from "2 500 zł") is the
  // authoritative value and is preserved.
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD block (additionalProperty + brand) ----
    const blocks = this._extractJsonLd(s);
    let detailBlock = null;
    for (const b of blocks) {
      if (b && b['@type'] === 'Product' && b.additionalType === 'Offer') {
        detailBlock = b;
        break;
      }
    }
    if (detailBlock) {
      // brand.name is "Oferta bezpośrednia" for owner-direct listings —
      // mark the ad with the "Bez pośredników" convenience (same convention
      // as adresowo/ofertyNet).
      const brand = detailBlock.brand;
      if (brand && /bezpośrednia|bezposrednia|osoba prywatna/i.test(String(brand.name || ''))) {
        if (!ad.conveniences) ad.conveniences = [];
        if (!ad.conveniences.some(c => c.type === 'direct')) {
          ad.conveniences.push({ type: 'direct', label: 'Bez pośredników' });
        }
      }

      // additionalProperty[] → raw.params + conveniences (Lift, Balcony, …)
      const props = Array.isArray(detailBlock.additionalProperty) ? detailBlock.additionalProperty : [];
      if (props.length) {
        const params = props
          .filter(p => p && p.name && p.value != null && String(p.value).trim() !== '')
          .map(p => ({ key: String(p.name), name: String(p.name), value: String(p.value) }))
          .slice(0, 20);
        if (params.length) {
          ad.raw = ad.raw || {};
          ad.raw.params = params;
          // Derive conveniences from the params list.
          const conv = this._inferConveniences(params);
          if (conv.length) {
            ad.conveniences = ad.conveniences || [];
            for (const c of conv) {
              if (!ad.conveniences.some(x => x.type === c.type)) ad.conveniences.push(c);
            }
          }
        }
      }

      // Title — prefer the detail's `name` (it's the same as the search card's
      // but defensive: a fallback regex-scraped card had title=null).
      if (detailBlock.name && (!ad.title || ad.title.startsWith('Mieszkanie na wynajem —'))) {
        ad.title = String(detailBlock.name).trim();
      }
    }

    // ---- 2. Full Polish description from <div class="t_1HMhyB"> ----
    // The page wraps the description in:
    //   <div class="t_Xw38Rb"><div class="t_1HMhyB">…full text with <br>…</div></div>
    // followed by sibling divs. We match non-greedy on the inner content,
    // stopping at the first `</div></div></div>` + sibling `<div` boundary
    // (verified on the Zawisza Wola fixture — 2701 chars captured correctly).
    const descM = s.match(/t_1HMhyB">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<div/i);
    if (descM) {
      const d = stripTags(descM[1]);
      if (d && d.length > (ad.description || '').length) {
        ad.description = d;
      }
    } else {
      // Fallback: greedy close on the next sibling div only.
      const altM = s.match(/t_1HMhyB">([\s\S]*?)<\/div>\s*<div/i);
      if (altM) {
        const d = stripTags(altM[1]);
        if (d && d.length > (ad.description || '').length) {
          ad.description = d;
        }
      }
    }

    // ---- 3. Full photo gallery from <img src="https://content.tabelaofert.pl/..."> ----
    // The page emits the same photo under several variant prefixes:
    //   - quality_80,scale_792,100642-/import/<slug>-00.webp  ← hero (photo #0)
    //   - quality_80,scale_245,100642-/import/<slug>-01..05.webp  ← gallery thumbs
    //   - thumb_200x200,100642-/import/<slug>-00.webp  ← small thumb
    //   - 100642-/import/<slug>-NN.webp  ← ORIGINAL (no variant prefix)
    //   - thumb_120x160,0-/no_person.png  ← agent avatar (filtered out)
    //
    // Two embedding sites per URL:
    //   1. Visible <img src="https://content.tabelaofert.pl/...">  (~6 refs)
    //   2. JSON-encoded React Server Components payload (Next.js RSC) with
    //      URLs in plain text sometimes followed by an escaped `\"` — the
    //      full gallery originals live here. (~30+ refs, deduped to ~19
    //      unique originals on the Zawiszy Wola fixture.)
    //
    // We grab ALL `https://content.tabelaofert.pl/<path>.webp` URLs in the
    // HTML (both src= and plain-text forms), then canonicalPhotoUrl strips
    // the variant prefix and rejects placeholders (no_person.png,
    // no-photo.webp), collapsing all variant references to one canonical
    // URL so dedup by URL keeps just one entry per photo.
    const photos = [];
    const seenUrls = new Set();
    // Match any content.tabelaofert.pl URL ending in .webp (case-insensitive).
    // The trailing `\\\\?` allows an optional escaped backslash (the RSC
    // payload JSON-encodes some URLs with a stray `\` after the closing quote
    // — `\"...webp\"`).
    const imgRe = /https:\/\/content\.tabelaofert\.pl\/[0-9a-zA-Z,_\-\/]+\.webp/gi;
    let m;
    while ((m = imgRe.exec(s)) !== null) {
      const canonical = canonicalPhotoUrl(m[0]);
      if (!canonical) continue;
      if (seenUrls.has(canonical)) continue;
      seenUrls.add(canonical);
      photos.push(canonical);
      if (photos.length >= 20) break; // persistListing cap
    }
    if (photos.length) ad.images = photos;

    // ---- 4. postedAt from "Data dodania: YYYY-MM-DD" on the params list ----
    // The detail page's HTML params block has a list item like
    //   <li class="t_-deJfz"><p class="t_oTeawX">Data dodania</p><p class="t_ptJTzb">2026-08-27</p></li>
    // We don't need to parse the full dl/dt/dd — the date pattern is unique
    // enough that a single regex catches it.
    if (!ad.postedAt) {
      const plM = s.match(/Data dodania<\/p><p[^>]*>(\d{4}-\d{2}-\d{2})/i);
      if (plM) {
        const parsed = parsePostedAt(plM[1]);
        if (parsed) ad.postedAt = parsed;
      }
    }
  }

  // Infer conveniences from the additionalProperty[] params list. Mirrors
  // the domiporta.js pattern (Polish labels: Winda, Balkon, Taras, …).
  _inferConveniences(params) {
    const conv = [];
    if (!Array.isArray(params) || !params.length) return conv;
    const get = (name) => {
      const p = params.find(x => x.name && x.name.toLowerCase().includes(name));
      return p ? String(p.value).toLowerCase() : null;
    };

    const winda = get('winda');
    if (winda && /tak|istnieje/i.test(winda)) conv.push({ type: 'lift', label: 'Winda' });

    const balkon = get('powierzchnie zewnętrzne');
    if (balkon && /balkon/i.test(balkon)) conv.push({ type: 'balcony', label: 'Balkon' });
    const balkon2 = get('powierzchnie dodatkowe');
    if (balkon2 && /balkon|taras|loggia/i.test(balkon2) && !conv.some(c => c.type === 'balcony')) {
      conv.push({ type: 'balcony', label: balkon2.charAt(0).toUpperCase() + balkon2.slice(1) });
    }

    const ogrzewanie = get('ogrzewanie');
    if (ogrzewanie && /miejskie|c\.o\./i.test(ogrzewanie)) {
      // Not a convenience in itself but worth noting — skip pushing as conv.
    }

    const instalacje = get('instalacje elektryczne');
    if (instalacje && /internet/i.test(instalacje)) {
      // Internet installed — useful, push as a utility convenience.
      conv.push({ type: 'internet', label: 'Internet' });
    }

    return conv.slice(0, 12);
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Tabelaofert's listing URLs are clean by default, but
  // normalizing defensively protects against future regressions and against
  // imported URLs with utm_*/fbclid etc. Mirrors B5 (adresowo), B2-5 (otodom),
  // B3-11 (olx), D1 (nieruchomosci-online), D2 (domiporta), D3 (oferty-net).
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
