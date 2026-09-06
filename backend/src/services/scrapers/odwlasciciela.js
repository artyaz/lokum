// odwlasciciela.pl scraper — direct-from-owner ("Od Właściciela") Polish rental
// portal. The unique value-add of this source is its direct-from-owner filter:
// every listing on the site is published by the property owner (the "Bezpośrednio"
// badge), so cross-source dedupe overlap with OLX/Otodom's agency listings is
// minimal. Plain fetch() is BLOCKED by a JS anti-bot challenge — the site's
// "wsidchk"/"pdata" verification page is returned on every cold request. We
// detect the challenge and fall back to Playwright's `fetchRendered()` (same
// pattern otodom.js / gratka.js use, but unconditional since the challenge
// always triggers for plain fetch on this site).
//
// Site layout (verified 2026-08-30 via curl + z-ai page_reader on live pages):
//
//   Search:  https://odwlasciciela.pl/mieszkania/wynajem/<wojewodztwo>,<miasto>.html?offset=N
//            e.g. https://odwlasciciela.pl/mieszkania/wynajem/mazowieckie,warszawa.html
//                 https://odwlasciciela.pl/mieszkania/wynajem/mazowieckie,warszawa.html?offset=20
//            20 listings/page; Warsaw yields ~30-50 pages = ~600-1000 listings.
//            Pagination uses ?offset=N (multiples of OFFERS_PER_PAGE=20).
//            The path filters to mieszkanie (apartments) — the unfiltered
//            `/oferty/wynajem/...` path also includes komercja (commercial)
//            listings, which we skip.
//
//            Each search card is `<article class="offers-item offers-item--featured">`:
//              - <a href="/oferty/podglad/<id>,mieszkanie-wynajme.html" class="offers-item__link cf">
//              - <img src="/assets/userfiles/offers/<XX>/<XXXX>/<photo_id>_0.jpg">
//              - <strong class="text--gray-2 text--medium">Warszawa Ochota</strong>  (district)
//              - <div class="text--gray-3">Al. Jerozolimskie 135</div>             (street, often empty)
//              - <span class="offers-item__attribute"> with attributes:
//                  <strong>Mieszkanie na wynajem</strong>  (type)
//                  <strong>37</strong>m2                    (area)
//                  L.pokoi: <strong>2</strong>                (rooms)
//                  Piętro: <strong>1/12</strong>             (floor current/total)
//              - <div class="d-flex text text--small text--gray-2 ...">desc</div> (truncated "...")
//              - <span class="text text--medium text--black font-weight-bold">3 000 <small>PLN</small></span>
//              - <span class="offers-item__badge mt-3">Bezpośrednio</span>  (direct marker)
//
//   Detail:  https://odwlasciciela.pl/oferty/podglad/<id>,mieszkanie-wynajme.html
//            Server-renders FOUR JSON-LD blocks (Organization, BreadcrumbList,
//            RealEstateListing, FAQPage). The RealEstateListing block has:
//              - name (full title — same as the search card's <h1>)
//              - description (FULL Polish text with \r\n line breaks)
//              - datePosted ("2026-08-26 21:59:13" — Europe/Warsaw local)
//              - expires   ("2026-10-25" — listing expiration date)
//              - url (canonical — same as the detail URL)
//            The HTML also contains:
//              - <div class="text text--gray-2">…full Polish text with <br>…</div>
//                after the "Opis" header (same content as JSON-LD description;
//                we use the JSON-LD version because it preserves \r\n cleanly)
//              - Slick slider gallery with N unique photos:
//                <img src="/assets/userfiles/offers/<XX>/<XXXX>/<photo_id>_2.jpg">
//                The slick-cloned slides duplicate photos for the infinite carousel —
//                we dedupe by URL.
//              - Params table: <div class="table__row"> with row pairs
//                <div class="col-6 text--gray-2">Label</div>
//                <div class="col-6 text--gray-1 font-weight-bold text-right">Value</div>
//                Carries: Województwo, Powiat, Miasto/Gmina, Kod pocztowy, Dzielnica/Wieś,
//                Ulica, Rynek, Piętro, Liczba pięter, Rodzaj budynku, Rok budowy budynku,
//                Okolica (POI list), Liczba pokoi, Powierzchnia użytkowa, Stan mieszkania,
//                Okna, Instalacje, Ogrzewanie, Media, Pomieszczenia dodatkowe.
//              - Map: COMMENTED OUT — the `var latlng = new google.maps.LatLng(52.05249,18.984375)`
//                is a default Poland center, not the listing's coords. The actual
//                geocoding was meant to happen client-side via Google Maps
//                Geocoder API, but the script is commented out so no coords
//                are exposed. We fall back to city-level coords (city.lat /
//                city.lng) — same tradeoff as wynajem24.js.
//
//   Photos:  Gallery URLs follow the pattern
//              https://odwlasciciela.pl/assets/userfiles/offers/<XX>/<XXXX>/<photo_id>_2.jpg
//            where _2.jpg is the slick-carousel size. _0.jpg is the search-card
//            thumbnail size; the originals exist as /assets/userfiles/offers/<XX>/<XXXX>/<photo_id>.jpg
//            but the page only renders the _2.jpg variant. We store the _2.jpg
//            URLs as-is (sufficient for the 8-12 minimum quality bar).
//
// Quality bar (per Task D brief):
//   - lat/lng: CITY-LEVEL FALLBACK (city.lat / city.lng) — the detail page's map
//     script is commented out so no listing-specific coords are exposed. The
//     fallback satisfies "lat/lng not null" with a small loss of precision
//     (acceptable: same tradeoff as wynajem24.js; services/dedupe.js catches
//     overlap via area + rooms fingerprint regardless of coord precision).
//   - photos: full slick gallery (10-11 unique photos on the sample listings;
//     direct-from-owner listings often have fewer — we extract what's there).
//   - description: full Polish text from JSON-LD RealEstateListing.description
//     (with \r\n line breaks preserved as \n).
//   - price: PLN/monthly from the search card's price span (the detail page
//     doesn't expose a separate price — JSON-LD RealEstateListing has no price
//     field, only `expires`).
//
// Inventory note: Warsaw yields ~30-50 pages × 20 listings = ~600-1000 listings
// per fetch cycle. With MAX_PAGES=30 (capped) we cover the freshest ~600
// listings. Pairs with the 3×/day recommended schedule (B8).
//
// Dedupe overlap (per C1 research): direct-from-owner portal — the "Bezpośrednio"
// badge on every listing means cross-source dedupe overlap is low (most
// listings here are exclusive to odwlasciciela.pl and don't appear on OLX /
// Otodom's agency-fed feeds). The dedupe pipeline (services/dedupe.js) catches
// the small overlap via geo + area + rooms fingerprint.

import { BaseScraper } from './base.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 13;
// 20 listings/page × 30 pages = ~600 listings/city/fetch — Warsaw has ~30-50
// pages, so MAX_PAGES=30 lets the walk hit the true last page naturally (where
// cards.length < SHORT_PAGE_THRESHOLD) and stop. Pairs with the 3×/day
// recommended schedule (B8).
const MAX_PAGES = 30;
// Page caps: 20 listings/page (verified on Warszawa page 1). Short-page
// early-stop uses HALF (=10) as the threshold so a natural ±1-2 fluctuation
// doesn't trigger a false break.
const OFFERS_PER_PAGE = 20;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset, or persistent anti-bot challenge). Pre-fix a single
// failure did `break` and silently dropped pages 6..30 even though page 5 was
// the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// Cap the number of detail-page fetches per cycle. With ~600 listings per walk
// and 4-worker pool, this caps at ~300 detail fetches per cycle — roughly
// 4-6 minutes at 2-3s/fetch (Playwright fallback is slower than plain fetch).
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value as
// domiporta/ofertyNet/nieruchomosciOnline for parity — 4 workers strikes the
// right balance between throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;

// City path map — województwo + miasto segments (comma-separated in URL path,
// ASCII lowercase without Polish diacritics).
const CITY_PATH = {
  warsaw:  { woj: 'mazowieckie',   miasto: 'warszawa' },
  krakow:  { woj: 'malopolskie',   miasto: 'krakow' },
  wroclaw: { woj: 'dolnoslaskie',  miasto: 'wroclaw' },
  gdansk:  { woj: 'pomorskie',     miasto: 'gdansk' },
  poznan:  { woj: 'wielkopolskie', miasto: 'poznan' }
};

// Markers to detect the anti-bot challenge page (HTML returns 200 OK with
// this content; we treat as a "soft failure" → fall back to fetchRendered).
// `wsidchk` is the form-field name the challenge script submits to the
// verification endpoint `/z0f76a1d14fd21a8fb5fd0d03e0fdc3d3cedae52f`.
// `Proszę czekać` is the Polish "Please wait" heading; `One moment, please`
// is the English variant (chosen via Accept-Language negotiation).
const CHALLENGE_MARKERS = ['wsidchk', 'Proszę czekać', 'One moment, please'];

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "3 000" (non-breaking-space thousand separator),
// "3,000.5" (decimal comma), "3000 zł" (zł suffix), "3&nbsp;000&nbsp;PLN"
// (HTML entity NBSP). Returns a Number (or null on failure). Mirrors
// domiporta.js parseNum but also strips the "zł"/"PLN" currency marker the
// search-card price span emits, decodes the literal `&nbsp;` HTML entity
// (the page-rendered HTML uses the entity text, not the actual U+00A0 char),
// and strips any inline HTML tags (e.g. `<small>PLN</small>`).
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
// breaks. <br> → newline, </p>/</li> → newline, <li> → bullet. Mirrors
// domiporta.js's stripTags.
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

// "2026-08-26 21:59:13" (Europe/Warsaw local, space-separated) → ISO 8601.
// The site embeds the local time without a timezone marker; we treat as
// Europe/Warsaw (CET=+1 winter / CEST=+2 summer). ±1h imprecision is harmless
// for was_new detection. Mirrors sprzedajemy.js's parsePostedAt pattern.
function parsePostedAt(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: date only — "2026-08-26"
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: native Date.parse
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export class OdwlascicielaScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as domiporta/ofertyNet/
  // nieruchomosciOnline/sprzedajemy/tabelaofert. When `supportsStreaming = true`,
  // the runner uses the `onListing` callback path which emits each listing as
  // it's parsed from the search cards — but the detail-page enrichment
  // (`_enrichNew`, which fetches the JSON-LD RealEstateListing for full
  // description / photos / postedAt) was conditional on `!onListing` and so
  // NEVER ran in streaming mode. Disabling streaming keeps peak memory
  // slightly higher (~3 MB for ~300 listings × 10 KB payload) but ensures the
  // enrich step actually runs.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'odwlasciciela',
      baseUrl: 'https://odwlasciciela.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const path = CITY_PATH[city.slug];
    if (!path) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('ODWLASCICIELA_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;

    for (let page = 1; page <= maxPages; page++) {
      const offset = (page - 1) * OFFERS_PER_PAGE;
      const params = new URLSearchParams();
      if (offset > 0) params.set('offset', String(offset));
      // Price filter — odwlasciciela.pl's search form doesn't expose price
      // query params (the sidebar filter is JS-driven, server-rendered links
      // only). We leave the filter to the runner's defensive pass — getting
      // it wrong here would silently 0-result the feed. Verified 2026-08-30.
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkania/wynajem/${path.woj},${path.miasto}.html${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetchBypassingChallenge(url);
        consecutiveFailures = 0;
      } catch (e) {
        console.warn(`[odwlasciciela] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[odwlasciciela] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip / TLS
        // renegotiation doesn't cascade into a hard abort.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[odwlasciciela] ${city.slug}: no cards on page 1`);
        else console.log(`[odwlasciciela] ${city.slug} page ${page}: empty page — stopping`);
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
        `[odwlasciciela] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 20 cards each (OFFERS_PER_PAGE);
      // the true last page returns fewer (e.g. 8 on a 600-listing feed = 30
      // pages × 20 + 1 page × 0-19). Use HALF of OFFERS_PER_PAGE as the
      // threshold so a natural fluctuation of ±1-2 cards doesn't trigger a
      // false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[odwlasciciela] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Fetch the URL, detecting the JS anti-bot challenge page and falling back
  // to Playwright's `fetchRendered()` when the challenge triggers. The site
  // uses a "wsidchk"/"pdata" verification form on EVERY cold request — plain
  // fetch always returns the challenge HTML (HTTP 200 with a 5-second meta-
  // refresh + a JS form submit). Playwright with the stealth init script
  // (see browser.js) passes the checks and gets the real content.
  //
  // The first fetch per process is ~3-5s (browser launch); subsequent fetches
  // reuse the singleton browser (faster). Total cost for a 30-page walk +
  // ~300 detail fetches is ~5-8 minutes — acceptable for a 3×/day schedule.
  async _fetchBypassingChallenge(url, { timeout = 30000, waitMs = 2500 } = {}) {
    // Step 1: try plain fetch — it's fast and works for ~all sources that
    // don't have anti-bot. If it fails or returns the challenge page, we
    // fall back to fetchRendered. (Even though we've verified the challenge
    // always triggers for odwlasciciela.pl, we still try plain first because:
    // (a) it's the documented pattern from otodom.js / gratka.js, (b) the
    // site might stop serving the challenge to certain IP ranges in the
    // future, and (c) the cost of a failed plain fetch is ~1 second.)
    let html = null;
    try {
      html = await this._fetch(url, { desktop: true, timeout: 15000 });
    } catch (e) {
      // plain fetch failed — fall through to fetchRendered
    }
    // Detect the challenge page → use Playwright fallback. The challenge is
    // unmistakable: it includes the literal `wsidchk` form-field name (which
    // never appears in real listing HTML) plus a localized "Proszę czekać" /
    // "One moment, please" heading.
    if (!html || CHALLENGE_MARKERS.some(m => html.includes(m))) {
      html = await fetchRendered(url, { waitMs, timeout, blockResources: false });
      // NOTE: blockResources is FALSE here — the anti-bot script does a
      // HEAD/XHR to /z0f76a1d14fd21a8fb5fd0d03e0fdc3d3cedae52f to set the
      // wsidchk cookie, and blocking it via makeRouteHandler() would make
      // the challenge never resolve. The default browser.js route handler
      // aborts known ad/analytics hosts but lets same-origin requests
      // through — that's fine; we still get image-blocking benefits from
      // the same route for the actual listing page requests.
    }
    return html;
  }

  // Parse listing cards from the search results HTML. Each card is an
  // `<article class="offers-item offers-item--featured">` block. We extract:
  // externalId (from the detail URL), thumbnail, district, street, area,
  // rooms, floor, partial description (truncated "..."), price, and the
  // "Bezpośrednio" badge marker. The detail-page JSON-LD (in `_enrichNew`)
  // overwrites these with more precise values where applicable.
  _parseSearchCards(html, city) {
    const out = [];
    const s = String(html);
    // Each card starts with `<article class="offers-item` — we split on that
    // marker and slice each chunk to ~8 KB (enough to capture all attributes
    // without grabbing the next card's content).
    const chunks = s.split('<article class="offers-item').slice(1);
    for (const chunkRaw of chunks) {
      try {
        const chunk = chunkRaw.slice(0, 8000);

        // Detail URL — `<a href="/oferty/podglad/<id>,<type>-wynajme.html"
        // class="offers-item__link cf">`. The href is relative; prepend the
        // base URL when persisting.
        const urlM = chunk.match(/<a\s+href="([^"]+)"\s+class="[^"]*offers-item__link[^"]*"/i);
        if (!urlM) continue;
        const pathUrl = urlM[1];

        // Extract numeric id + listing type from the URL.
        // Path: /oferty/podglad/43366,mieszkanie-wynajme.html
        // The type segment can be: mieszkanie, komercja, dom, dzialka, lokal
        const idM = pathUrl.match(/\/oferty\/podglad\/(\d+),([a-z]+)-wynajme\.html/);
        if (!idM) continue;
        const externalId = idM[1];
        const listingType = idM[2];
        // Skip non-residential (komercja = commercial, dom = house, dzialka =
        // plot, lokal = commercial premises). Only mieszkanie (apartment)
        // matches our rent-listing schema. The /mieszkania/wynajem/... search
        // path already filters to mieszkanie, but defensive — protects
        // against the unfiltered /oferty/wynajem/... path.
        if (listingType !== 'mieszkanie') continue;

        const fullUrl = pathUrl.startsWith('http') ? pathUrl : `${this.baseUrl}${pathUrl}`;

        // District — `<strong class="text--gray-2 text--medium">Warszawa Ochota</strong>`.
        // The text contains both the city name + district (e.g. "Warszawa Ochota",
        // "Warszawa Targówek", "Warszawa Wola"). We strip the leading city name
        // to get just the district; if no district (e.g. just "Warszawa"), keep
        // the whole string as district.
        const locM = chunk.match(/<strong class="text--gray-2 text--medium">([^<]+)<\/strong>/i);
        const locText = locM ? locM[1].replace(/\s+/g, ' ').trim() : city.name_pl;
        // Split "Warszawa Ochota" → ["Warszawa", "Ochota"]; use the part after
        // the city name. If only the city is given, leave district as null
        // (the runner's defensive filter handles null districts).
        let district = locText;
        if (locText.startsWith(city.name_pl + ' ')) {
          district = locText.slice(city.name_pl.length + 1).trim();
        } else if (locText === city.name_pl) {
          district = null;
        }

        // Street — `<div class="text--gray-3">Al. Jerozolimskie 135</div>`.
        // Often empty (just `<div class="text--gray-3"></div>`) for listings
        // where the owner didn't enter a street.
        const streetM = chunk.match(/<div class="text--gray-3">([^<]*)<\/div>/i);
        const street = streetM && streetM[1].trim() ? streetM[1].trim() : null;

        // Attributes — Pow/Pokoje/Piętro (the three the card surfaces).
        // Each is a `<span class="offers-item__attribute">` block, but the
        // attribute label/value position differs:
        //   <span class="offers-item__attribute"><strong>Mieszkanie na wynajem</strong></span>  (type — no label)
        //   <span class="offers-item__attribute"><strong>37</strong>m2</span>                  (area — no label, value+m2 after strong)
        //   <span class="offers-item__attribute">L.pokoi: <strong>2</strong></span>             (rooms — label BEFORE strong)
        //   <span class="offers-item__attribute">Piętro: <strong>1/12</strong></span>          (floor — label BEFORE strong)
        // We use distinct regex patterns per attribute to avoid the generic
        // regex matching the first attribute (type) when we look for area
        // (the optional label capture would match "Mieszkanie na wynajem"
        // from the type attribute instead).
        const area = this._extractArea(chunk);
        const rooms = this._extractRooms(chunk);
        const floor = this._extractFloor(chunk);

        // Thumbnail — first `<img src="/assets/userfiles/offers/...">` in the
        // card (the search-card thumbnail at _0.jpg size).
        const imgM = chunk.match(/<img[^>]+src="(\/assets\/userfiles\/offers\/[^"]+)"/i);
        const thumb = imgM
          ? (imgM[1].startsWith('http') ? imgM[1] : `${this.baseUrl}${imgM[1]}`)
          : null;

        // Description — `<div class="d-flex text text--small text--gray-2 py-4
        // pr-4 pl-4 pl-md-0">…truncated with "..."…</div>`. The full text
        // comes from the detail page's JSON-LD RealEstateListing.description
        // in `_enrichNew`.
        const descM = chunk.match(/<div class="d-flex text text--small text--gray-2 py-4 pr-4 pl-4 pl-md-0">([\s\S]*?)<\/div>/i);
        const description = descM ? stripTags(descM[1]) : '';

        // Price — the search card surfaces price + price/m² together in the
        // footer:
        //   <span class="text text--medium text--black font-weight-bold">3&nbsp;000&nbsp;<small>PLN</small></span>
        //   <span class="text text--gray-2 font-weight-bold ml-5 mr-auto">
        //     <span class="mr-3">81&nbsp;<small>PLN/m2</small></span>
        //   </span>
        // The first span is the absolute monthly price; the second is the
        // per-m² price (we ignore it). Strip the <small>PLN</small> suffix.
        const priceM = chunk.match(
          /<span class="text text--medium text--black font-weight-bold">([\s\S]*?)<\/span>\s*<span class="text text--gray-2 font-weight-bold ml-5 mr-auto">/i
        );
        const price = parseNum(priceM ? priceM[1] : '');
        if (!price || price <= 0) continue; // skip listings without a price

        // Direct-from-owner badge — `<span class="offers-item__badge mt-3">
        // Bezpośrednio</span>`. Every listing on this portal is direct-from-
        // owner, but we record the badge to raw for the dedupe pipeline's
        // "owner-direct" cross-source matching.
        const directM = chunk.match(/<span[^>]*class="[^"]*offers-item__badge[^"]*"[^>]*>\s*(Bezpośrednio|Bezposrednio|Bez pośredników)\s*<\/span>/i);
        const directBadge = directM ? directM[1].trim() : null;

        // Title — synthesize from district + area + rooms since the card
        // doesn't have a separate title field (the <h1> is on the detail page).
        // The detail-page enrichment (`_applyDetail`) overwrites this with
        // the JSON-LD RealEstateListing.name (the canonical title).
        const titleParts = [
          'Mieszkanie na wynajem',
          district ? district : city.name_pl
        ].filter(Boolean);
        if (area) titleParts.push(`${area} m²`);
        if (rooms) titleParts.push(`${rooms} pokoje`);
        const title = titleParts.join(' — ');

        out.push({
          externalId,
          sourceId: SOURCE_ID,
          cityId: city.id,
          title,
          description,
          price: Math.round(price),
          currency: 'PLN',
          rooms: rooms != null ? parseInt(String(rooms).replace(/[^\d]/g, ''), 10) || null : null,
          area: area != null ? parseNum(area) : null,
          floor: floor != null ? String(floor).trim() : null,
          district,
          street,
          address: [street, district].filter(Boolean).join(', ') || district || city.name_pl,
          // lat/lng: city-level fallback. The detail page's map code is
          // commented out so no listing-specific coords are exposed; we use
          // city.lat / city.lng as the fallback to satisfy the "lat/lng not
          // null" quality bar. (Same tradeoff as wynajem24.js — small loss of
          // precision but services/dedupe.js catches overlap via area + rooms
          // fingerprint regardless.)
          lat: city.lat,
          lng: city.lng,
          url: this._normalizeUrl(fullUrl),
          postedAt: null, // backfilled from detail-page JSON-LD datePosted
          images: thumb ? [thumb] : [],
          conveniences: directBadge
            ? [{ type: 'direct', label: 'Bez pośredników' }]
            : [],
          raw: {
            url: fullUrl,
            searchCard: {
              thumb,
              listingType,
              directBadge
            }
          }
        });
      } catch (e) {
        // skip broken card — single failure shouldn't abort the walk
      }
    }
    return out.filter(a => a.price > 0 && a.externalId);
  }

  // Extract the area attribute from a card's chunk. Pattern:
  //   <span class="offers-item__attribute"><strong>37</strong>m2</span>
  // The `m2` suffix after `</strong>` is required (so the regex doesn't
  // match the type attribute `<strong>Mieszkanie na wynajem</strong>`).
  // Returns the numeric string (e.g. "37") or null.
  _extractArea(chunk) {
    const m = chunk.match(
      /<span\s+class="[^"]*offers-item__attribute[^"]*"[^>]*>\s*<strong>([\d.,]+)<\/strong>\s*m2\s*<\/span>/i
    );
    return m ? m[1].trim() : null;
  }

  // Extract the rooms attribute from a card's chunk. Pattern:
  //   <span class="offers-item__attribute">L.pokoi: <strong>2</strong></span>
  // Returns the numeric string (e.g. "2") or null.
  _extractRooms(chunk) {
    const m = chunk.match(
      /<span\s+class="[^"]*offers-item__attribute[^"]*"[^>]*>\s*L\.pokoi:\s*<strong>(\d+)<\/strong>\s*<\/span>/i
    );
    return m ? m[1].trim() : null;
  }

  // Extract the floor attribute from a card's chunk. Pattern:
  //   <span class="offers-item__attribute">Piętro: <strong>1/12</strong></span>
  // Returns the floor string (e.g. "1/12") or null.
  _extractFloor(chunk) {
    const m = chunk.match(
      /<span\s+class="[^"]*offers-item__attribute[^"]*"[^>]*>\s*Piętro:\s*<strong>([^<]+)<\/strong>\s*<\/span>/i
    );
    return m ? m[1].trim() : null;
  }

  // Extract a numeric attribute from a card's chunk by its Polish label or
  // marker. The pattern is:
  //   <span class="offers-item__attribute"><strong>37</strong>m2</span>
  //   <span class="offers-item__attribute">L.pokoi: <strong>2</strong></span>
  //   <span class="offers-item__attribute">Piętro: <strong>1/12</strong></span>
  // We grab the inner text of the <strong> element. Returns null if the
  // attribute isn't on this card.
  //
  // NOTE: this generic helper is kept for backward compatibility / future
  // attribute extraction. The search-card parsing uses the dedicated
  // _extractArea / _extractRooms / _extractFloor methods above because
  // the generic regex's optional `(?:labelRe:?\s*)?` capture would match
  // the FIRST attribute (the type `<strong>Mieszkanie na wynajem</strong>`)
  // when looking for area (which has no label).
  _extractAttribute(chunk, labelRe) {
    const re = new RegExp(
      `<span\\s+class="[^"]*offers-item__attribute[^"]*"[^>]*>(?:${labelRe}:?\\s*)?<strong>([^<]+)</strong>`,
      'i'
    );
    const m = chunk.match(re);
    if (!m) return null;
    return m[1].trim();
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full Polish description, full photo gallery,
  // datePosted, and address/params backfill. Uses the 4-worker Promise pool
  // pattern (ENRICH_CONCURRENCY = 4) from domiporta/ofertyNet/sprzedajemy so
  // we don't pin event-loop memory on a 300-listing walk.
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
    console.log(`[odwlasciciela] enriching ${fresh.length} listings (desc/photos/params)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetchBypassingChallenge(ad.url);
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't crash the whole pool
          console.warn(`[odwlasciciela] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 250ms between fetches per worker (Playwright fallback
        // is heavier than plain fetch; slightly longer backoff than the 150ms
        // domiporta/ofertyNet/sprzedajemy use).
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Sources:
  //   1. JSON-LD RealEstateListing block (PRIMARY) → name, full description,
  //      datePosted, expires
  //   2. Slick slider gallery → full photo URLs (8-12 unique photos)
  //   3. Params table (table__row blocks) → Piętro, Liczba pięter, Powierzchnia
  //      użytkowa, Liczba pokoi, address parts (Dzielnica, Ulica)
  //   4. Direct marker in JSON-LD `brand` or page text → "Bez pośredników"
  //      convenience marker
  //
  // IMPORTANT: lat/lng stay at the city-level fallback set during the search
  // walk — the detail page's map code is commented out and exposes no
  // listing-specific coords.
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD RealEstateListing block ----
    const blocks = this._extractJsonLd(s);
    let relBlock = null;
    for (const b of blocks) {
      if (b && b['@type'] === 'RealEstateListing') { relBlock = b; break; }
    }
    if (relBlock) {
      // Description — the FULL Polish text with \r\n line breaks. JSON-LD
      // preserves the agent-written formatting (verified on sample listing
      // 43366: 6 paragraphs, ~800 words, includes costs/układ/lokalizacja/
      // FAQ sections). Meets the quality bar without needing a separate
      // <div> extraction.
      if (relBlock.description && String(relBlock.description).length > (ad.description || '').length) {
        const desc = String(relBlock.description)
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (desc) ad.description = desc;
      }

      // Title — JSON-LD `name` is the full Polish title (matches the detail
      // page's <h1>). Always overwrites the synthesized search-card title.
      if (relBlock.name) {
        ad.title = String(relBlock.name).trim();
      }

      // postedAt — JSON-LD datePosted ("2026-08-26 21:59:13" Europe/Warsaw).
      if (relBlock.datePosted) {
        const parsed = parsePostedAt(relBlock.datePosted);
        if (parsed) ad.postedAt = parsed;
      }

      // Save expires to raw for the dedupe / translate pipeline.
      if (relBlock.expires) {
        ad.raw = ad.raw || {};
        ad.raw.expires = String(relBlock.expires);
      }
    }

    // ---- 2. Full photo gallery from the slick slider ----
    // The page emits the same photo URL multiple times (the slick slider
    // duplicates photos for the infinite carousel via `slick-cloned` slides).
    // We grab ALL `<img src="/assets/userfiles/offers/.../..._N.jpg">` URLs
    // and dedupe by URL. The slick gallery uses `_2.jpg` (medium size); the
    // search card uses `_0.jpg` (small thumb). Both are valid full URLs —
    // we store the gallery's `_2.jpg` URLs as the canonical photos.
    const photos = [];
    const seenUrls = new Set();
    // Match any /assets/userfiles/offers/<XX>/<XXXX>/<photo_id>_<N>.jpg URL.
    // The slick-cloned slides will produce duplicate URLs that we dedupe.
    const imgRe = /\/assets\/userfiles\/offers\/\d+\/\d+\/\d+_\d+\.jpg/gi;
    let m;
    while ((m = imgRe.exec(s)) !== null) {
      const url = `${this.baseUrl}${m[0]}`;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      photos.push(url);
      if (photos.length >= 20) break; // persistListing cap
    }
    if (photos.length) ad.images = photos;

    // ---- 3. Params table (backfill) ----
    // The detail page's params block uses `<div class="table__row">` rows
    // with `<div class="col-6 text--gray-2">Label</div><div class="col-6
    // text--gray-1 font-weight-bold text-right">Value</div>`. The block
    // carries: Województwo, Powiat, Miasto/Gmina, Kod pocztowy, Dzielnica/
    // Wieś, Ulica, Rynek, Piętro, Liczba pięter, Rodzaj budynku, Rok budowy
    // budynku, Okolica (POI list), Liczba pokoi, Powierzchnia użytkowa, Stan
    // mieszkania, Okna, Instalacje, Ogrzewanie, Media, Pomieszczenia dodatkowe.
    const params = this._extractParamsTable(s);
    if (params.area != null && params.area > 0) ad.area = params.area;
    if (params.rooms != null && params.rooms > 0) ad.rooms = params.rooms;
    if (params.floor != null) ad.floor = String(params.floor).trim();
    if (params.street && !ad.street) ad.street = params.street;
    if (params.district) ad.district = params.district;
    if (params.address) {
      ad.address = [params.street || ad.street, params.district || ad.district]
        .filter(Boolean).join(', ') || params.address;
    }

    // Conveniences — the params table includes "Media" (often lists internet
    // availability), "Pomieszczenia dodatkowe" (often lists piwnica/komórka),
    // and "Okolica" (lists POIs like fitness, basen, bank, apteka, PKP, PKS,
    // autobus, tramwaj, plac zabaw, szkoła). Infer from these + the
    // description text like sprzedajemy does.
    if ((!ad.conveniences || !ad.conveniences.length || ad.conveniences.length <= 1)) {
      const conv = this._inferConveniences(params, ad.description);
      if (conv.length) {
        ad.conveniences = ad.conveniences || [];
        for (const c of conv) {
          if (!ad.conveniences.some(x => x.type === c.type)) ad.conveniences.push(c);
        }
      }
    }

    // Save the publisher name (Organization JSON-LD block) + raw params to
    // raw for the dedupe / translate pipeline.
    ad.raw = ad.raw || {};
    if (params.rawParams) ad.raw.params = params.rawParams;
    // Mark every listing as direct-from-owner (the portal's USP).
    if (!ad.conveniences.some(c => c.type === 'direct')) {
      ad.conveniences.push({ type: 'direct', label: 'Bez pośredników' });
    }
  }

  // Extract the params table from the detail page. Each row is a
  // `<div class="table__row">` block with a label + value pair. We map the
  // keys we care about to our schema; the full list is preserved in
  // rawParams for the translate pipeline.
  _extractParamsTable(html) {
    const out = {
      area: null, rooms: null, floor: null, street: null,
      district: null, address: null, rawParams: []
    };
    // Pattern: <div class="col-6 text--gray-2">Label</div>\s*<div class="col-6
    // text--gray-1 font-weight-bold text-right">Value</div> — the value div
    // may contain <sup>2</sup> (for m² exponents) and other inline tags, so
    // we use [\s\S]*? to capture across newlines + entities.
    const re = /<div class="col-6 text--gray-2">([^<]+)<\/div>\s*<div class="col-6 text--gray-1[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const label = m[1].trim();
      const valueRaw = m[2];
      const value = stripTags(valueRaw).trim();
      if (!label || !value) continue;
      out.rawParams.push({ key: label, value });
      const lv = label.toLowerCase();
      if (lv === 'powierzchnia użytkowa' || lv === 'powierzchnia') {
        const a = parseNum(value);
        if (a != null && a > 0) out.area = a;
      } else if (lv === 'liczba pokoi') {
        const n = parseInt(value.replace(/[^\d]/g, ''), 10);
        if (!isNaN(n) && n > 0) out.rooms = n;
      } else if (lv === 'piętro' || lv === 'pietro') {
        // Floor can be "1", "1/12", "parter", "0". Keep as string.
        out.floor = value;
      } else if (lv === 'ulica' || lv === 'adres') {
        out.street = value;
      } else if (lv === 'dzielnica / wieś' || lv === 'dzielnica' || lv === 'miasto / gmina') {
        if (!out.district) out.district = value;
      }
    }
    return out;
  }

  // Infer conveniences from the params list + description text. The params
  // list has structured amenities (Media, Pomieszczenia dodatkowe, Okolica)
  // and the description often mentions them too — we check both sources.
  // Mirrors sprzedajemy.js's _inferConveniences pattern.
  _inferConveniences(params, description) {
    const conv = [];
    const mediaStr = (params.rawParams || [])
      .filter(p => /media/i.test(p.key))
      .map(p => String(p.value).toLowerCase())
      .join(' ');
    const roomsStr = (params.rawParams || [])
      .filter(p => /pomieszczenia dodatkowe|pomieszczenia/i.test(p.key))
      .map(p => String(p.value).toLowerCase())
      .join(' ');
    const aroundStr = (params.rawParams || [])
      .filter(p => /okolica/i.test(p.key))
      .map(p => String(p.value).toLowerCase())
      .join(' ');
    const descStr = String(description || '').toLowerCase();
    const allText = `${mediaStr} ${roomsStr} ${aroundStr} ${descStr}`;

    if (allText.match(/\b(balkon|loggia|taras)\b/)) {
      conv.push({ type: 'balcony', label: 'Balkon' });
    }
    if (allText.match(/\bgara[sz]\b/)) {
      conv.push({ type: 'garage', label: 'Garaż' });
    }
    if (allText.match(/\bogr[oó]dek\b|\bogr[oó]d\b/)) {
      conv.push({ type: 'garden', label: 'Ogródek' });
    }
    if (allText.match(/\b(parking|miejsce parkingowe|stanowisko)\b/)) {
      conv.push({ type: 'park', label: 'Parking' });
    }
    if (allText.match(/\bwinda\b/)) {
      conv.push({ type: 'lift', label: 'Winda' });
    }
    if (allText.match(/\bpiwnica|kom[oó]rka\b/)) {
      conv.push({ type: 'cellar', label: 'Piwnica' });
    }
    if (allText.match(/\binternet\b/)) {
      conv.push({ type: 'internet', label: 'Internet' });
    }
    // POI in the Okolica list — surface nearby amenities.
    if (allText.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/)) {
      const mm = allText.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/);
      if (mm) conv.push({ type: 'market', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    if (allText.match(/\b(metro|tramwaj|autobus|stacja|przystanek)\b/)) {
      const mm = allText.match(/\b(metro|tramwaj|autobus)\b/);
      if (mm) conv.push({ type: 'transport', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    if (allText.match(/\b(fitness|siłownia|basen)\b/)) {
      conv.push({ type: 'gym', label: 'Siłownia / Fitness nearby' });
    }
    if (allText.match(/\b(szkoła|przedszkole)\b/)) {
      conv.push({ type: 'school', label: 'Szkoła / Przedszkole nearby' });
    }
    return conv.slice(0, 5);
  }

  // Strip tracking/marketing query params so the same listing always produces
  // the same stored URL (mirrors the olx/domiporta/ofertyNet/sprzedajemy
  // pattern). odwlasciciela.pl listing URLs are clean by default
  // (`/oferty/podglad/<id>,<type>-wynajme.html` with no query string), but
  // normalizing defensively protects against future regressions and against
  // imported URLs with utm_*/fbclid etc.
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
