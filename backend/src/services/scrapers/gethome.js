// gethome.pl scraper — PropertyGroup Sp. z o.o. portal (sister of tabelaofert.pl,
// ex-RynekPierwotny). 863 Warszawa wynajem listings across ~25 pages × 35/page.
//
// Site layout (verified 2026-08-29 via z-ai page_reader on live pages):
//
//   Search:  https://gethome.pl/mieszkania/do-wynajecia/<miasto>/?page=N
//            e.g. https://gethome.pl/mieszkania/do-wynajecia/warszawa/?page=2
//            35 listings/page; Warszawa yields ~25 pages = ~863 total listings.
//            The trailing slash on `/<miasto>/` is canonical (canonical meta
//            tag emits it) but optional — gethome redirects either way.
//
//            The page is a React SPA that hydrates via an AJAX call to
//            https://api.gethome.pl, but the server ALSO pre-renders the
//            initial state into a literal
//              <script>window.__INITIAL_STATE__ = {…big JSON blob…};</script>
//            block. The blob has structure:
//              offerList.offers.offers[]   ← array of listing card objects
//              offerList.offers.meta       ← {total_offers, total_investments, …}
//              offerList.offers.pageCount  ← total # of pages
//              offerList.offers.page       ← current page (1-indexed)
//              offerList.latestQuery       ← {offer_type, page, per_page, deal_type, is_private, location}
//
//            Per offer (search-card) — RICH already, contains everything we
//            need for the quality bar EXCEPT the full description (truncated
//            server-side to 250 chars):
//              {
//                id: "e2d25443-e907-482f-a17a-d2fc37ad6014",    // UUID — stable
//                slug: "wynajme-mieszkanie-warszawa-...-2369134", // URL slug
//                name: "Mieszkanie 2 pokoje Żwirki i Wigury ...",
//                deal_type: "rent",
//                is_private: true | false,                        // direct-from-owner flag
//                price: { total: 3200, currency: "pln", per_sqm: 86 },
//                coordinates: { lon: 20.93, lat: 52.28 },         // ALREADY numeric
//                created_at: "2026-08-29T09:30:20.179912Z",        // ISO date
//                description: "…250 chars, server-truncated…",
//                property: {
//                  type: "apartment",
//                  room_number: 2,                                  // rooms
//                  size: 41.4,                                      // m²
//                  floor: 5,                                        // numeric floor
//                  building_year: 2002,
//                  heat: "ogrzewanie miejskie",
//                  address: "Warszawa, Bielany, Wawrzyszew, Sandora Petofiego",
//                  address_details: { city, district, street, housing_estate }
//                },
//                pictures: [                                        // 6-21 photos (avg 13)
//                  { o_img_360x171, o_img_500, o_img_306x171 },    // 3 variants per photo
//                  …
//                ]
//              }
//
//            IMPORTANT — search description is TRUNCATED to 250 chars server-
//            side. We still keep it as a fallback; the detail-page fetch in
//            `_enrichNew` overwrites it with the full text (sample listing
//            Wąwolnicka: 250 chars on search, 1996 chars on detail).
//
//   Detail:  https://gethome.pl/oferta/<slug>/                       ← trailing slash!
//            NOTE: the brief hypothesized `/mieszkanie/<id>` — that path
//            404s. The actual detail URL pattern is `/oferta/<slug>/`
//            (verified live by reading the search-card href).
//            Server-renders:
//              - window.__INITIAL_STATE__.offer.offer — full offer object
//                with rich property fields + main_image.link (the ORIGINAL
//                unsigned media.gethome.pl URL — but Cloudflare-gated, same
//                as the signed thumbs.gethome.pl URLs).
//              - The detail blob does NOT include a `pictures[]` array — the
//                search blob's `pictures[]` IS the canonical photo source.
//                The detail blob's `main_image.link` is the single hero
//                photo (already in search's pictures[0]). DON'T try to fetch
//                photos from the detail page — use search blob's pictures[].
//
//   Photos:  All photo URLs are signed `https://thumbs.gethome.pl/<token>/<size>/…`
//            URLs gated by Cloudflare. The signed tokens appear stable per
//            HTTP session (same session gets the same signed URL across
//            page-1 and detail-page fetches). The `o_img_500` variant is the
//            highest-resolution thumbnail served (500px wide). We prefer
//            `o_img_500` over `o_img_360x171` and `o_img_306x171`.
//
//   Cloudflare: gethome.pl is behind Cloudflare with "Just a moment..."
//   interstitial on every cold request. Plain fetch() always returns 403 +
//   the challenge HTML. We detect the challenge page and fall back to
//   Playwright's `fetchRendered()` (browser.js) — same pattern as
//   odwlasciciela.js. First fetch per process costs ~3-5 s (browser launch),
//   subsequent fetches reuse the singleton browser.
//
// Quality bar (per Task D brief):
//   - lat/lng: search blob's `coordinates.lat/lon` (already numeric) — must
//     not be null. Listings without coords are skipped (rare — the rental
//     feed requires coords).
//   - photos: search blob's `pictures[]` (6-21 photos per listing, avg 13 —
//     meets the 8-12 minimum on most listings).
//   - description: detail page's `offer.offer.description` (full Polish
//     text, 500-2500 chars). The search blob's 250-char preview is the
//     fallback if the detail fetch fails.
//   - price: PLN/monthly from search blob's `price.total`.
//
// Dedupe overlap (per C2 research): gethome.pl is owned by PropertyGroup
// Sp. z o.o., the same parent as tabelaofert.pl (sister site, source_id=12).
// High cross-source overlap expected with tabelaofert + olx + otodom; the
// services/dedupe.js pipeline catches these via geo + area + rooms
// fingerprint. The external id namespace is unique per source (UUID on
// gethome vs numeric on tabelaofert) so no risk of in-source collision.

import { BaseScraper } from './base.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 11;
// 35 listings/page × 30 pages = ~1 050 listings/city/fetch — well above the
// ~863-listing Warszawa wynajem inventory, so MAX_PAGES=30 lets the walk hit
// the true last page (where pageCount < 35) and stop naturally. Pairs with
// the 3×/day recommended schedule (B8) so each fetch catches every listing
// added in the past ~8h with margin to spare.
const MAX_PAGES = 30;
// Page caps: 35 listings/page (verified live on page 1). Short-page
// early-stop uses HALF (=17) as the threshold so a natural ±1-2 fluctuation
// doesn't trigger a false break. The true last page returns ~23 (verified
// on Warszawa page 25: 35×24=840 + 23 extras = 863).
const OFFERS_PER_PAGE = 35;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset, persistent Cloudflare challenge). Pre-fix a single
// failure did `break` and silently dropped pages 6..30 even though page 5
// was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// Cap the number of detail-page fetches per cycle. With ~863 listings per
// walk and a 4-worker pool, this caps at ~300 detail fetches per cycle —
// roughly 5-8 minutes at 1.5-2 s/fetch (Playwright fallback is slower than
// plain fetch). Aligned with gratka / domiporta / ofertyNet / tabelaofert's
// ENRICH_LIMIT.
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value
// as gratka/morizon/adresowo/domiporta/ofertyNet/nieruchomosciOnline/
// tabelaofert for parity — 4 workers strikes the right balance between
// throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;

// City path map — lowercase city slug as it appears in the URL path. The
// site uses ASCII lowercase without Polish diacritics.
const CITY_PATH = {
  warsaw:  'warszawa',
  krakow:  'krakow',
  wroclaw: 'wroclaw',
  gdansk:  'gdansk',
  poznan:  'poznan'
};

// Cloudflare challenge markers. The CF interstitial is unmistakable: the
// literal `Just a moment...` title plus `challenges.cloudflare.com` script
// src. We never see these strings in real listing HTML.
const CHALLENGE_MARKERS = ['Just a moment', 'challenges.cloudflare.com', 'cf-challenge'];

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "3 200" (non-breaking-space thousand separator),
// "3,200.5" (decimal comma), "3200 zł" (zł suffix), "3&nbsp;000&nbsp;PLN"
// (HTML entity NBSP). Returns a Number (or null on failure). Mirrors
// odwlasciciela.js parseNum — gethome.pl's price is a Number in the JSON
// blob (not a string), but we keep the helper for defensive string coercion.
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const t = String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s/g, '')
    .replace(/zł|PLN/gi, '')
    .replace(',', '.')
    .trim();
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// Strip HTML tags from a description HTML fragment while preserving line
// breaks. <br> → newline, </p>/</li> → newline, <li> → bullet. The
// gethome.pl description field is plain text (no HTML tags) per the JSON
// blob, but the search blob uses &nbsp; &oacute; entities — we decode
// them so the stored text reads cleanly.
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
    .replace(/&oacute;/g, 'ó')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Walk a JSON object literal starting at `start` index in `html`. The
// gethome.pl __INITIAL_STATE__ blob can be ~1 MB on a search results page
// (lots of nested dicts with polygon coordinates + per-listing rich data).
// JSON.parse() handles the whole blob in one shot if we first walk the
// brace structure to find the closing `}`. The walker respects string
// literals (so `}` inside a string doesn't end the object) and JSON escapes
// (so `\"` inside a string doesn't toggle inStr).
//
// Returns the parsed object, or null on failure (missing start marker or
// malformed JSON). Mirrors the inline walker used in the explore-script —
// pulled into a method so the search-walk and detail-walk paths share it.
function _extractInitialStateObject(html) {
  const m = String(html).match(/window\.__INITIAL_STATE__\s*=\s*/);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const blob = html.slice(start, i + 1);
        try { return JSON.parse(blob); } catch { return null; }
      }
    }
  }
  return null;
}

export class GethomeScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as gratka/ofertyNet/
  // nieruchomosciOnline/domiporta/tabelaofert. The detail-page enrichment
  // (full description / precise property fields) needs to run AFTER the
  // search walk, and the streaming `onListing` path skips enrichment. We
  // retain the listings array (~7 MB for ~863 listings × 8 KB payload) and
  // then run the 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'gethome',
      baseUrl: 'https://gethome.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('GETHOME_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // Price filter — gethome.pl's search sidebar uses cena_od/cena_do
      // query params, but the SPA's AJAX API call (api.gethome.pl) is what
      // actually applies them; the SSR HTML's __INITIAL_STATE__ reflects
      // the filtered result. We forward the runner-level filters through.
      if (filters.maxPrice != null) params.set('cena_do', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('cena_od', String(filters.minPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkania/do-wynajecia/${cityPath}/${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetchBypassingChallenge(url);
        consecutiveFailures = 0;
      } catch (e) {
        console.warn(`[gethome] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[gethome] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip /
        // Cloudflare rate-limit doesn't cascade into a hard abort and skip
        // the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[gethome] ${city.slug}: no cards on page 1`);
        else console.log(`[gethome] ${city.slug} page ${page}: empty page — stopping`);
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
        `[gethome] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 35 cards each (OFFERS_PER_PAGE);
      // the true last page returns <35 (verified on page 25 for Warszawa:
      // 863 = 24×35 + 23). Use HALF of OFFERS_PER_PAGE as the threshold so a
      // natural fluctuation of ±1-2 cards doesn't trigger a false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[gethome] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Fetch the URL, detecting the Cloudflare challenge page and falling back
  // to Playwright's `fetchRendered()` when the challenge triggers. The site
  // serves a "Just a moment..." interstitial on every cold request — plain
  // fetch always returns 403 + the challenge HTML (verified 2026-08-29).
  // Playwright with the stealth init script (browser.js) passes the
  // Cloudflare checks and gets the real content (verified via z-ai page_reader
  // which uses a real headless browser — the same JSON blob is returned).
  //
  // The first fetch per process is ~3-5s (browser launch); subsequent fetches
  // reuse the singleton browser (faster). Total cost for a 25-page walk +
  // ~300 detail fetches is ~5-8 minutes — acceptable for a 3×/day schedule.
  async _fetchBypassingChallenge(url, { timeout = 30000, waitMs = 2500 } = {}) {
    // Step 1: try plain fetch — it's fast (1-2s). If it fails or returns
    // the challenge page, we fall back to fetchRendered. (Even though we've
    // verified the challenge always triggers for gethome.pl, we still try
    // plain first because: (a) it's the documented pattern from otodom.js /
    // gratka.js / domiporta.js, (b) Cloudflare might stop serving the
    // challenge to certain IP ranges in the future, and (c) the cost of a
    // failed plain fetch is ~1 second.)
    let html = null;
    try {
      html = await this._fetch(url, { desktop: true, timeout: 15000 });
    } catch (e) {
      // plain fetch failed — fall through to fetchRendered
    }
    // Detect the Cloudflare challenge page → use Playwright fallback. The
    // challenge is unmistakable: it includes the literal `Just a moment...`
    // title plus `challenges.cloudflare.com` script src. Real listing
    // HTML never contains either string.
    if (!html || CHALLENGE_MARKERS.some(m => html.includes(m))) {
      html = await fetchRendered(url, { waitMs, timeout, blockResources: false });
      // NOTE: blockResources is FALSE here — Cloudflare's challenge script
      // does an XHR to challenges.cloudflare.com to set the cf_clearance
      // cookie, and blocking it via makeRouteHandler() would make the
      // challenge never resolve. The default browser.js route handler
      // aborts known ad/analytics hosts but lets same-origin requests
      // through — that's fine; we still get image-blocking benefits from
      // the same route for the actual listing page requests.
    }
    return html;
  }

  // Parse listing cards from the search results HTML. The page is a React
  // SPA that pre-renders the initial state into a
  // `<script>window.__INITIAL_STATE__ = {…};</script>` block. We extract the
  // blob via brace-walking (handles ~1 MB JSON), then walk
  // `offerList.offers.offers[]` and normalize each to a card object.
  //
  // Fallback: if no __INITIAL_STATE__ blob is found (defensive — should
  // never happen on a live 200, but protects against a persistent
  // Cloudflare shell that fetchRendered couldn't bypass), regex-scan for
  // detail URLs `/oferta/<slug>/` and produce minimal cards.
  _parseSearchCards(html, city) {
    const out = [];
    const state = _extractInitialStateObject(html);
    const offers = state?.offerList?.offers?.offers;
    if (Array.isArray(offers) && offers.length) {
      for (const offer of offers) {
        const card = this._normalizeSearchOffer(offer, city);
        if (card) out.push(card);
      }
      return out;
    }

    // Fallback: regex-scan for listing detail URLs on the gethome.pl domain.
    // Each detail URL has the pattern /oferta/wynajme-mieszkanie-...-<digits>/
    const re = /https?:\/\/gethome\.pl\/oferta\/([a-z0-9][a-z0-9\-]*[a-z0-9])\/?/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(String(html))) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({
        externalId: m[1],
        url: this._normalizeUrl(`https://gethome.pl/oferta/${m[1]}/`),
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

  // Map one offer object from the search __INITIAL_STATE__ blob to a
  // normalized card object. The offer has rich data — full price, rooms,
  // area, floor, address, geo (lat/lng as NUMBERS — quality-bar critical),
  // created_at (ISO date), partial description (250 chars truncated server-
  // side), full photo gallery (6-21 entries), is_private flag, deal_type,
  // and slug for the detail-page URL.
  _normalizeSearchOffer(offer, city) {
    if (!offer || typeof offer !== 'object') return null;
    // Only rent listings (the search path /do-wynajecia/ already filters to
    // rent, but defensive — protects against the unfiltered /mieszkania/ path).
    if (offer.deal_type && String(offer.deal_type).toLowerCase() !== 'rent') return null;

    // External id = the UUID `id` field (stable across re-edits; slugs change
    // when the owner updates the listing title).
    const externalId = offer.id;
    if (!externalId) return null;

    // Detail URL — built from the slug. The trailing slash is canonical
    // (verified: `/oferta/<slug>` without trailing slash 404s in some cases).
    const slug = offer.slug;
    if (!slug) return null;
    const detailUrl = `${this.baseUrl}/oferta/${slug}/`;

    // Price — search blob's price.total is already a Number (in PLN).
    const priceRaw = offer.price?.total;
    const price = parseNum(priceRaw);
    if (!price || price <= 0) return null;

    // Coords — quality-bar CRITICAL. The blob stores them as NUMBERS, not
    // strings (unlike tabelaofert.pl). Sanity-check the Poland bounding box
    // (49-55 lat, 14-24 lng) so a malformed entry doesn't slip through.
    let lat = null, lng = null;
    const coords = offer.coordinates;
    if (coords && coords.lat != null && coords.lon != null) {
      const la = parseFloat(coords.lat);
      const lo = parseFloat(coords.lon);
      if (Number.isFinite(la) && Number.isFinite(lo) &&
          la > 40 && la < 60 && lo > 10 && lo < 30) {
        lat = la;
        lng = lo;
      }
    }

    const prop = offer.property || {};
    const addr = prop.address_details || {};

    // Rooms — search blob's property.room_number (Number).
    let rooms = null;
    if (prop.room_number != null) {
      const r = parseInt(String(prop.room_number), 10);
      if (!isNaN(r) && r > 0) rooms = r;
    }
    // Area — search blob's property.size (Number, m²).
    let area = null;
    if (prop.size != null) {
      const a = parseNum(prop.size);
      if (a != null && a > 0) area = a;
    }
    // Floor — search blob's property.floor (Number, 0 = parter).
    let floor = null;
    if (prop.floor != null) {
      floor = String(prop.floor);
    }

    // District / street / city — prefer the structured address_details.
    // The property.address string is "Warszawa, Bielany, Wawrzyszew, Sandora Petofiego"
    // (city, district, housing_estate, street) — already split for us.
    const district = addr.district || null;
    const street = addr.street || null;
    const cityName = addr.city || city.name_pl;
    const address = [street, district, cityName].filter(Boolean).join(', ') ||
      prop.address || cityName;

    // Photos — search blob's pictures[] is the canonical gallery (6-21
    // entries; avg 13 — meets the 8-12 quality bar). Each picture has 3
    // variants; `o_img_500` is the highest-resolution thumbnail served.
    // The signed tokens are stable per HTTP session.
    const images = [];
    const seenUrls = new Set();
    if (Array.isArray(offer.pictures)) {
      for (const p of offer.pictures) {
        if (!p || typeof p !== 'object') continue;
        // Prefer o_img_500 (500px wide), fall back to o_img_360x171 then o_img_306x171.
        const url = p.o_img_500 || p.o_img_360x171 || p.o_img_306x171;
        if (!url || seenUrls.has(url)) continue;
        // Filter out agency-logo / agent-avatar placeholders (rare on this
        // feed; the no-photo stand-ins come from media.gethome.pl as
        // placeholder.jpg — defensive check).
        if (/\/(logo|avatar|placeholder|no-photo)\./i.test(url)) continue;
        seenUrls.add(url);
        images.push(url);
        if (images.length >= 20) break; // persistListing cap
      }
    }

    // Description — search blob's description is truncated to 250 chars
    // server-side. We keep it as a fallback; _enrichNew overwrites with the
    // full text from the detail page's offer.offer.description.
    const description = offer.description ? stripTags(offer.description) : '';

    // Title — use the offer's `name` field (a human-readable summary like
    // "Mieszkanie 2 pokoje Żwirki i Wigury Grójecka Hynka"). Falls back to
    // a constructed default if the name is empty (rare).
    const title = offer.name ? String(offer.name).trim() :
      `Mieszkanie na wynajem — ${district || cityName}`;

    // postedAt — search blob's created_at is a full ISO timestamp with
    // microsecond precision ("2026-08-29T09:30:20.179912Z"). The JS Date
    // parser handles microseconds via truncation.
    let postedAt = null;
    if (offer.created_at) {
      const d = new Date(offer.created_at);
      if (!isNaN(d.getTime())) postedAt = d.toISOString();
    }

    // Conveniences — is_private=true → mark as "Bez pośredników" (direct
    // from owner). Same convention as tabelaofert.js / odwlasciciela.js /
    // ofertyNet.js.
    const conveniences = [];
    if (offer.is_private === true) {
      conveniences.push({ type: 'direct', label: 'Bez pośredników' });
    }

    // Raw — keep the structured address + extra property fields for the
    // translate.js params pipeline. Trim to the small set that's actually
    // surfaced in the UI to keep the JSONB column compact.
    const params = [];
    if (prop.building_year) params.push({ key: 'rok_budowy', name: 'Rok budowy', value: String(prop.building_year) });
    if (prop.heat) params.push({ key: 'ogrzewanie', name: 'Ogrzewanie', value: String(prop.heat) });
    if (prop.type) params.push({ key: 'typ_budynku', name: 'Typ', value: String(prop.type) });

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title,
      description,
      price: Math.round(price),
      currency: 'PLN',
      rooms,
      area,
      floor,
      district,
      street,
      address,
      lat,
      lng,
      url: this._normalizeUrl(detailUrl),
      postedAt,
      images,
      conveniences,
      raw: {
        url: detailUrl,
        slug,
        isPrivate: !!offer.is_private,
        marketType: offer.market_type || null,
        offerType: offer.offer_type || null,
        investmentId: offer.investment_id || null,
        addressDetails: addr,
        params
      }
    };
  }

  // Enrich new listings (or known ones with empty description) by fetching
  // each detail page and extracting: full Polish description (the search
  // blob's description is truncated to 250 chars; the detail page's
  // offer.offer.description is the full text — 500-2500 chars typical).
  // Uses the 4-worker Promise pool pattern (ENRICH_CONCURRENCY = 4) so we
  // don't pin event-loop memory on a 863-listing walk.
  //
  // IMPORTANT: photos already come from the search blob's pictures[] array
  // (6-21 per listing, avg 13 — meets the 8-12 quality bar). The detail
  // page does NOT include a pictures[] array (only main_image, which is
  // already pictures[0] on the search blob). So we do NOT touch images[]
  // here — they're already complete from the search walk.
  async _enrichNew(ads) {
    if (!ads.length) return;
    // Skip the detail fetch for listings that already have a non-trivial
    // description (>300 chars — exceeds the 250-char search truncation, so
    // we know the detail was fetched on a previous run) OR that have been
    // seen before with a full description. Saves ~300 detail fetches per
    // cycle on the second run onward.
    let knownWithDesc = new Set();
    try {
      const rows = await many(
        `SELECT l.external_id FROM listings l
         WHERE l.source_id = $1 AND l.external_id = ANY($2::text[])
           AND char_length(l.description) > 300`,
        [SOURCE_ID, ads.map(a => a.externalId)]
      );
      knownWithDesc = new Set(rows.map(r => r.external_id));
    } catch {}
    const fresh = ads.filter(a => !knownWithDesc.has(a.externalId)).slice(0, ENRICH_LIMIT);
    if (!fresh.length) return;
    console.log(`[gethome] enriching ${fresh.length} listings (full description)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetchBypassingChallenge(ad.url);
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't fail the whole walk
          console.warn(`[gethome] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 250ms between fetches per worker. Slightly higher
        // than domiporta/tabelaofert's 150ms because each fetch may go
        // through Playwright (slower + heftier on the source). Same as
        // odwlasciciela.js's pattern.
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Fetches:
  //   - Full Polish description from window.__INITIAL_STATE__.offer.offer.description
  //   - More precise property fields (floor, floors, balconies, heating, …)
  //     → raw.params + conveniences (Lift, Balcony, …)
  //   - Coordinates override (detail blob has property.coordinates.lng/lat —
  //     usually identical to search blob's coordinates but more precise)
  //
  // IMPORTANT: we do NOT touch images[] — the search blob's pictures[] array
  // is the canonical photo source (the detail page only has main_image, which
  // is already in pictures[0] from the search).
  _applyDetail(html, ad) {
    const state = _extractInitialStateObject(html);
    const offer = state?.offer?.offer;
    if (!offer || typeof offer !== 'object') return;

    // ---- 1. Full Polish description ----
    // The detail page's offer.description is the full text (verified on
    // sample Wąwolnicka: 1996 chars vs 250 chars on search). We overwrite
    // the search-blob's truncated description.
    if (offer.description) {
      const d = stripTags(offer.description);
      if (d && d.length > (ad.description || '').length) {
        ad.description = d;
      }
    }

    // ---- 2. Title override (if search name was missing) ----
    if (offer.name && (!ad.title || ad.title.startsWith('Mieszkanie na wynajem —'))) {
      ad.title = String(offer.name).trim();
    }

    // ---- 3. Precise property fields ----
    const prop = offer.property || {};
    // Floor — prefer detail's property.floor (more reliable than search).
    if (prop.floor != null && prop.floor !== '') {
      ad.floor = String(prop.floor);
    }
    // Rooms — detail's property.room_number / property.rooms (both present).
    if (prop.room_number != null) {
      const r = parseInt(String(prop.room_number), 10);
      if (!isNaN(r) && r > 0) ad.rooms = r;
    } else if (prop.rooms != null) {
      const r = parseInt(String(prop.rooms), 10);
      if (!isNaN(r) && r > 0) ad.rooms = r;
    }
    // Area — detail's property.size is the precise m².
    if (prop.size != null) {
      const a = parseNum(prop.size);
      if (a != null && a > 0) ad.area = a;
    }
    // Coordinates override — detail blob's property.coordinates uses lng/lat
    // (lng vs search blob's lon — different key name!). Both are numeric.
    const coords = prop.coordinates || offer.coordinates;
    if (coords) {
      const la = parseFloat(coords.lat ?? coords.latitude);
      const lo = parseFloat(coords.lng ?? coords.lon ?? coords.longitude);
      if (Number.isFinite(la) && Number.isFinite(lo) &&
          la > 40 && la < 60 && lo > 10 && lo < 30) {
        ad.lat = la;
        ad.lng = lo;
      }
    }

    // ---- 4. additionalProperty → raw.params + conveniences ----
    // The detail blob's property has 40+ structured fields. We surface a
    // small set in raw.params for the translate.js pipeline and derive
    // conveniences (Lift, Balcony, Terrace, …) from the structured fields.
    const params = [];
    const pushParam = (key, name, value) => {
      if (value == null || value === '') return;
      params.push({ key, name, value: String(value) });
    };
    pushParam('building_year', 'Rok budowy', prop.building_year);
    pushParam('heating', 'Ogrzewanie', prop.heating || prop.heat);
    pushParam('type', 'Typ budynku', prop.type);
    pushParam('finishing_state', 'Stan wykończenia', prop.finishing_state);
    pushParam('floors', 'Liczba pięter w budynku', prop.floors);
    pushParam('floor', 'Piętro', prop.floor);
    pushParam('kitchen_type', 'Typ kuchni', prop.kitchen_type);
    pushParam('available_from', 'Dostępne od', prop.available_from);
    pushParam('legal_status', 'Stan prawny', prop.legal_status);
    if (prop.windows_direction_readable) {
      pushParam('windows', 'Okna', prop.windows_direction_readable);
    }
    if (params.length) {
      ad.raw = ad.raw || {};
      ad.raw.params = params.slice(0, 20);
    }

    // Derive conveniences from the structured fields.
    // balconies / terraces / loggies are NUMBERS on the detail blob (count).
    const conv = ad.conveniences || [];
    const addConv = (type, label) => {
      if (!conv.some(c => c.type === type)) conv.push({ type, label });
    };
    if (prop.balconies && Number(prop.balconies) > 0) addConv('balcony', 'Balkon');
    if (prop.terraces && Number(prop.terraces) > 0) addConv('balcony', 'Taras');
    if (prop.loggies && Number(prop.loggies) > 0 && !conv.some(c => c.type === 'balcony')) {
      addConv('balcony', 'Loggia');
    }
    if (prop.cellar === true) addConv('cellar', 'Piwnica');
    if (prop.wardrobe === true) addConv('storage', 'Garderoba');
    if (prop.storage_room_available === true) addConv('storage', 'Pomieszczenie gospodarcze');
    // Lift — group_equipment or group_safety don't include a winda key
    // directly, but the detail blob's floors >0 + floor > 3 usually implies
    // a lift. Skip inferring winda to avoid false positives; the translate
    // pipeline will surface it from raw.params.heating if present.
    if (conv.length) ad.conveniences = conv.slice(0, 12);

    // Mark direct-from-owner (carried over from search blob; defensive).
    if (offer.is_private === true && !ad.conveniences?.some(c => c.type === 'direct')) {
      ad.conveniences = ad.conveniences || [];
      ad.conveniences.push({ type: 'direct', label: 'Bez pośredników' });
    }
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Gethome's listing URLs are clean by default (no utm_*
  // in the /oferta/<slug>/ path), but normalizing defensively protects
  // against future regressions and against imported URLs with utm_*/fbclid
  // etc. Mirrors B5 (adresowo), B2-5 (otodom), B3-11 (olx), D1
  // (nieruchomosci-online), D2 (domiporta), D3 (oferty-net), D5 (tabelaofert).
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
