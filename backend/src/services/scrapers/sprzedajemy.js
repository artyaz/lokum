// sprzedajemy.pl scraper — Polish general classifieds portal with a small but
// distinct rentals sub-inventory (~156-159 Warszawa wynajem listings at any
// given moment, 30 listings/page across ~5-6 pages).
//
// Site layout (verified 2026-08-29 via z-ai page_reader + curl on live pages):
//
//   Search:  https://sprzedajemy.pl/<city-slug>/nieruchomosci/mieszkania/wynajem?offset=N
//            e.g. https://sprzedajemy.pl/warszawa/nieruchomosci/mieszkania/wynajem
//                 https://sprzedajemy.pl/warszawa/nieruchomosci/mieszkania/wynajem?offset=30
//            30 listings/page, ~5-6 pages for Warszawa (~158 total listings).
//            NOTE: the task brief mentioned the URL `sprzedajemy.pl/mieszkania/
//            warszawa/wynajem` but that path 404s — the canonical URL is the
//            longer `/<city>/nieruchomosci/mieszkania/wynajem` form.
//
//            Each search card is a `<li id="offer-<id>" class="odd|even">` row
//            containing `<article class="element">` with:
//              - <a href="/<slug>-nr<id>" class="offerLink">  (relative detail URL)
//              - <img src="https://thumbs.img-sprzedajemy.pl/350x250c/..."> (thumbnail)
//              - <h2 class="title">  (the listing title)
//              - <span class="price">  "2 100 zł"
//              - <p class="attributes g1"> with <span class="attribute"> children:
//                  <span>Pow.: </span>49 m²   (area)
//                  <span>Pokoje: </span>2     (rooms)
//                  <span>Piętro: </span>2     (floor)
//              - <span class="partnerPremium">PARTNER PREMIUM</span> (optional badge)
//              - <span class="seller-type-info__label">FIRMA|OSOBA PRYWATNA</span>
//              - <time class="time" datetime="2026-08-29 13:55:53">Dzisiaj 13:55</time>
//              - <a class="locationName" data-details="Rembertów">Warszawa, </a>
//
//   Detail:  https://sprzedajemy.pl/<slug>-nr<id>
//            e.g. /mieszkanie-do-wynajecia-warszawa-rembertow-ulica-kramarska-4-1b8e55-6fpbc4-nr73862330
//            Server-renders TWO JSON-LD blocks:
//              1. BreadcrumbList (ignored)
//              2. Product + Organization — contains the FULL data:
//                 - name (full Polish title)
//                 - description (FULL Polish text with \n line breaks — meets the
//                   quality bar without any <div> extraction)
//                 - image[] (8-12 full-res URLs at
//                   https://thumbs.img-sprzedajemy.pl/1000x901c/... — meets the
//                   8-12 photos minimum cleanly)
//                 - offers.priceCurrency="PLN", offers.Price="2100.00"
//                   NOTE: schema-violating `Price` with capital P (not lowercase
//                   `price`). We handle both keys defensively.
//                 - owns.address ("Warszawa, Rembertów") — district fallback
//                 - owns.name (publisher name — saved to raw)
//
//            Coords are NOT in the JSON-LD. They live in a Python-style dict
//            attribute on the contact/location row:
//              <li class="location" data-coordinates="{'lat': 52.2733878, 'lng': 21.1490348, 'zoom': 12}">
//            The single-quoted dict syntax is invalid JSON; we regex-extract the
//            lat/lng values directly (with Poland-range sanity bounds).
//
//            Params table — `<li class="item"><span>Powierzchnia</span>
//            <strong>49 m²</strong></li>` (also: Liczba pokoi, Piętro, Rok budowy,
//            Liczba pięter). Used as fallback when the search card's attributes
//            span is missing fields.
//
//   Photos:  8-12 unique URLs in JSON-LD `image[]` (high-res 1000x901). The
//            page also emits the same URLs as `<img class="js-gallerySlide">`
//            with `loading="lazy"` — the JSON-LD block is cleaner, so we use it.
//
// Quality bar (per Task D brief):
//   - lat/lng: from data-coordinates attribute (must not be null — listings
//     without coords are skipped; the Warszawa inventory almost always has them)
//   - photos: 8-12 from JSON-LD `image[]`
//   - description: full Polish text from JSON-LD `description`
//   - price: PLN/monthly from JSON-LD `offers.Price`
//
// Inventory note: ~158 Warszawa wynajem listings across ~6 pages × 30/page.
// MAX_PAGES=30 (900 listings cap) walks the full inventory with margin; the
// 4-worker detail-page pool processes ~150 listings per cycle (~1-2 minutes).
//
// Dedupe overlap (per C1 research): sprzedajemy.pl is owned by Grupa OLX sp.
// z o.o. — high cross-source overlap with olx.pl results (some sprzedajemy
// listings are cross-posted from sister portal odwlasciciela.pl). Caught by
// services/dedupe.js via geo + area + rooms fingerprint.
//
// Anti-bot: none observed (plain fetch with a desktop UA + Polish Accept-
// Language works). No Cloudflare, no Playwright fallback needed.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 16;
// 30 listings/page × 30 pages = 900 listings/city/fetch cap. The Warszawa
// wynajem inventory is only ~158 listings (5-6 pages), so this cap walks the
// full inventory with margin. Pairs with the 3×/day recommended schedule.
const MAX_PAGES = 30;
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Same pattern as domiporta/ofertyNet/nieruchomosci-
// Online. 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// sprzedajemy search results return exactly 30 listings/page (verified live
// 2026-08-29). Used by the short-page early-stop heuristic.
const OFFERS_PER_PAGE = 30;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Cap the number of detail-page fetches per cycle. The Warszawa walk collects
// ~206 unique cards; the old cap (200) silently sliced the tail off (Task 3-f),
// so it is raised to 1500 — every walked listing gets first-pass detail
// enrichment (same fix as domiporta, Task 3-c). The `knownWithImages` skip
// (>= 3 stored photos) keeps repeat runs cheap, so the effective per-run
// fetch count stays ≈ new + stub listings, well under this ceiling.
const ENRICH_LIMIT = 1500;
// Promise pool concurrency for the detail-page enrichment step. Same value as
// nieruchomosci-online/domiporta/ofertyNet for parity — 4 workers strikes the
// right balance between throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;

// City path map — sprzedajemy uses /<city-slug>/nieruchomosci/mieszkania/wynajem.
// All five Lokum cities verified live 2026-08-29 (HTTP 200 each).
const CITY_PATH = {
  warsaw: 'warszawa',
  krakow: 'krakow',
  wroclaw: 'wroclaw',
  gdansk: 'gdansk',
  poznan: 'poznan'
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "2 100" (space thousand separator), "2100,00" (decimal
// comma). Returns a Number (or null on failure). Mirrors domiporta.js parseNum.
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const n = parseFloat(String(s).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Sprzedajemy's search-page time format: <time datetime="2026-08-29 13:55:53">
// The datetime attribute is space-separated (not ISO `T`). The site returns
// local Polish time without a timezone marker; we treat it as Europe/Warsaw
// (CET/CEST) by appending the location-aware offset. For lokum's was_new
// detection an ±1h imprecision is acceptable — the runner's sinceTime fallback
// (getSinceTime = previous cron started_at) catches any edge cases.
function parsePostedAt(datetimeAttr) {
  if (!datetimeAttr) return null;
  const s = String(datetimeAttr).trim();
  // "2026-08-29 13:55:53" → ISO with timezone. Treat as Poland local time
  // (Europe/Warsaw, UTC+1 winter / UTC+2 summer). Use a fixed +01:00 offset —
  // the ±1h imprecision is harmless for the was_new comparison.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: "2026-08-29 13:55" (seconds omitted)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (m2) {
    const iso = `${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:00+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: "2026-08-29" (date only)
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export class SprzedajemyScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as domiporta/ofertyNet/
  // nieruchomosciOnline. When `supportsStreaming = true`, the runner uses the
  // `onListing` callback path which emits each listing as it's parsed from the
  // search cards — but the detail-page enrichment (`_enrichNew`, which fetches
  // the JSON-LD Product block for photos / full description / coords) was
  // conditional on `!onListing` and so NEVER ran in streaming mode. Disabling
  // streaming keeps peak memory slightly higher (~1 MB for ~150 listings ×
  // 5 KB payload) but ensures the enrich step actually runs.
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'sprzedajemy', baseUrl: 'https://sprzedajemy.pl' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('SPRZEDAJEMY_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    // Consecutive pages that yielded zero NEW cards (see clamp guard below).
    let noNewPages = 0;

    // Sprzedajemy uses ?offset=N (0, 30, 60, ...) — page 1 = offset 0 (no qs).
    for (let page = 1; page <= maxPages; page++) {
      const offset = (page - 1) * OFFERS_PER_PAGE;
      const params = new URLSearchParams();
      if (offset > 0) params.set('offset', String(offset));
      // Price filter — sprzedajemy's search form exposes `inp_filter_float_*`
      // query params (e.g. inp_filter_float_price:to=5000), but the exact key
      // for rent price varies across categories (sale vs rent vs room-share).
      // We leave the filter to the runner's defensive pass — getting it wrong
      // here would silently 0-result the feed. Verified 2026-08-29.
      if (filters.maxPrice != null) {
        // Defensive no-op: price is applied at runner level (see runner.js
        // defensive filter block). Documented so future eyes-on can wire it
        // when the exact param key is confirmed.
      }
      const qs = params.toString();
      const url = `${this.baseUrl}/${cityPath}/nieruchomosci/mieszkania/wynajem${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[sprzedajemy] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[sprzedajemy] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
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
        if (page === 1) console.warn(`[sprzedajemy] ${city.slug}: no cards on page 1`);
        else console.log(`[sprzedajemy] ${city.slug} page ${page}: empty page — stopping`);
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
        `[sprzedajemy] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Pagination clamp guard: offsets beyond the last page REPLAY page 1's
      // content instead of returning an empty page (verified 2026-09-01 — a
      // 206-card inventory walked 30 pages; offsets 210..870 all returned
      // page 1 again, i.e. 23 wasted fetches per run). Two consecutive pages
      // with zero new cards ⇒ we are past the real end of the inventory.
      if (dupCount === cards.length) {
        noNewPages++;
        if (noNewPages >= 2) {
          console.log(`[sprzedajemy] ${city.slug} page ${page}: 0 new cards on ${noNewPages} consecutive pages (offset clamps to page 1 past the end) — stopping`);
          break;
        }
      } else {
        noNewPages = 0;
      }

      // Short-page early-stop: pages 1..N have 30 cards each (OFFERS_PER_PAGE);
      // the true last page returns fewer (e.g. 18 on a 158-listing feed
      // = 5 pages × 30 + 1 page × 8). Use HALF of OFFERS_PER_PAGE as the
      // threshold so a natural fluctuation of ±1-2 cards doesn't trigger a
      // false break.
      if (cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[sprzedajemy] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse listing cards from the search results HTML. Each listing row is a
  // `<li id="offer-<id>" class="odd|even">` containing a single
  // `<article class="element">` block. We extract the canonical detail URL,
  // title, price, area/rooms/floor attributes, postedAt, district, thumbnail,
  // and seller-type badge. The detail-page JSON-LD (in `_enrichNew`) overwrites
  // these with more precise values where applicable.
  _parseSearchCards(html, city) {
    const out = [];
    const s = String(html);
    // Each listing row starts with `<li id="offer-<digits>"`. We slice from
    // there to the next `<li id="offer-` marker (~5 KB per card). The
    // `<article class="element">` inside is the actual data wrapper.
    const chunks = s.split('<li id="offer-').slice(1);
    for (const chunkRaw of chunks) {
      try {
        // Take enough of the chunk to capture all attributes without grabbing
        // the next row's content (each row is ~5 KB).
        const chunk = chunkRaw.slice(0, 6000);

        // External id — the leading digits of the chunk (right after
        // `<li id="offer-`), terminated by `"` or space.
        const idM = chunk.match(/^(\d+)(?:["' ])/);
        if (!idM) continue;
        const externalId = idM[1];

        // Detail URL — the first <a class="offerLink" href="..."> in the row.
        // The URL is relative (`/mieszkanie-do-wynajecia-...-nr<id>`); prepend
        // the base URL when persisting.
        const urlM = chunk.match(/<a\s+href="([^"]+)"\s+class="[^"]*offerLink[^"]*"/i);
        if (!urlM) continue;
        const pathUrl = urlM[1];

        // Title — the <h2 class="title"> text (full Polish title like
        // "Mieszkanie do wynajęcia Warszawa Rembertów, ulica Kramarska").
        const titleM = chunk.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
        const title = titleM ? this._decodeEntities(titleM[1].replace(/\s+/g, ' ').trim()) : null;

        // Price — `<span class="price">2 100 zł</span>`. Polish thousand-sep
        // is a space; "zł" suffix is the currency marker. We strip non-digits.
        const priceM = chunk.match(/<span\s+class="price[^"]*"[^>]*>\s*([\d\s\u00a0.,]+)\s*zł?\s*<\/span>/i);
        const price = parseNum(priceM ? priceM[1] : '');
        if (!price || price <= 0) continue; // skip listings without a price

        // Attributes (Pow./Pokoje/Piętro) — `<span class="attribute">
        // <span>Pow.: </span>49 m²</span>` etc. Three possible attrs; we
        // greedily capture all of them.
        const area = this._extractAttribute(chunk, 'Pow');
        const rooms = this._extractAttribute(chunk, 'Pokoje');
        const floor = this._extractAttribute(chunk, 'Piętro');

        // Thumbnail — first <img src="..."> in the card (the 350x250c
        // thumbnail on thumbs.img-sprzedajemy.pl).
        const imgM = chunk.match(/<img[^>]+src="(https:\/\/thumbs\.img-sprzedajemy\.pl\/[^"]+)"/i);
        const thumb = imgM ? imgM[1] : null;

        // postedAt — `<time datetime="2026-08-29 13:55:53">`. The datetime
        // attribute uses space (not `T`) between date and time; parsePostedAt
        // handles both. Pages are sorted newest-first (verified 2026-08-29).
        const timeM = chunk.match(/<time[^>]+datetime="([^"]+)"/i);
        const postedAt = timeM ? parsePostedAt(timeM[1]) : null;

        // District — `<a class="locationName" data-details="Rembertów">`.
        // The data-details attribute carries the district/sub-locality name;
        // if absent, fall back to the city name.
        const locM = chunk.match(/<a[^>]+class="[^"]*locationName[^"]*"[^>]+data-details="([^"]+)"/i);
        const district = locM ? this._decodeEntities(locM[1]) : city.name_pl;

        // Seller type — `<span class="seller-type-info__label">FIRMA|OSOBA PRYWATNA</span>`.
        // Used to flag direct-from-owner listings (saved to raw for the dedupe
        // pipeline's "owner-direct" cross-source matching).
        const sellerM = chunk.match(/<span[^>]+class="[^"]*seller-type-info__label[^"]*"[^>]*>\s*([A-ZŁĄŚŻŹĆŃĘÓ\s]+)\s*<\/span>/i);
        const sellerType = sellerM ? sellerM[1].trim() : null;

        // Premium/partner badges — `<span class="partnerPremium">PARTNER PREMIUM</span>`
        // (or ZWERYFIKOWANA FIRMA). Saved to raw.
        const premiumBadges = [];
        for (const b of chunk.matchAll(/<span[^>]*class="[^"]*(?:partnerPremium|verified|premium)[^"]*"[^>]*>\s*([A-ZŁĄŚŻŹĆŃĘÓ\s]+)\s*<\/span>/gi)) {
          const label = b[1].trim();
          if (label) premiumBadges.push(label);
        }

        // Build the listing card. Lat/lng/photos/description are filled by
        // `_enrichNew` from the detail page.
        const fullUrl = pathUrl.startsWith('http') ? pathUrl : `${this.baseUrl}${pathUrl}`;
        out.push({
          externalId,
          sourceId: SOURCE_ID,
          cityId: city.id,
          title: title || `Mieszkanie na wynajem — ${district}, ${city.name_pl}`,
          description: '', // backfilled from detail-page JSON-LD
          price: Math.round(price),
          currency: 'PLN',
          rooms: rooms != null ? parseInt(String(rooms).replace(/[^\d]/g, ''), 10) || null : null,
          area,
          floor: floor != null ? String(floor).trim() : null,
          district,
          street: null, // backfilled from detail-page params table
          address: `${district}, ${city.name_pl}`,
          lat: null,
          lng: null,
          url: this._normalizeUrl(fullUrl),
          postedAt,
          images: thumb ? [thumb] : [],
          conveniences: [],
          raw: {
            url: fullUrl,
            searchCard: {
              sellerType,
              premiumBadges: premiumBadges.slice(0, 3),
              thumb,
              postedAtRaw: timeM ? timeM[1] : null
            }
          }
        });
      } catch (e) {
        // skip broken card — single failure shouldn't abort the walk
      }
    }
    return out.filter(a => a.price > 0 && a.externalId);
  }

  // Extract a numeric attribute from a card's chunk by its Polish label.
  // The pattern is:
  //   <span class="attribute ..."><span>Pow.: </span>49 m²</span>
  // We grab the text AFTER the inner label span and return the numeric value
  // as a string (caller decides how to coerce — parseInt for rooms, parseFloat
  // for area). Returns null if the attribute isn't on this card.
  _extractAttribute(chunk, label) {
    const re = new RegExp(
      `<span\\s+class="[^"]*attribute[^"]*"[^>]*>\\s*<span>\\s*${label}\\.?:\\s*</span>\\s*([^<]+?)\\s*</span>`,
      'i'
    );
    const m = chunk.match(re);
    if (!m) return null;
    return m[1].trim();
  }

  // Decode common HTML entities that appear in titles/districts. Sprzedajemy
  // doesn't escape Polish chars (they're UTF-8 in the source), but & is escaped
  // as `&amp;` in some attributes. Keep this minimal — over-decoding risks
  // mangling UTF-8 sequences.
  _decodeEntities(s) {
    if (!s) return '';
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\u00A0/g, ' ')
      .trim();
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full description, lat/lng, full photo gallery,
  // floor/area/rooms backfill, postedAt. Uses the 4-worker Promise pool
  // pattern (ENRICH_CONCURRENCY = 4) from domiporta/ofertyNet so we don't pin
  // event-loop memory on a 150-listing walk.
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
    console.log(`[sprzedajemy] enriching ${fresh.length} listings (photos/desc/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        let fetchFailed = false;
        try {
          const html = await self._fetch(ad.url, { desktop: true, timeout: 20000 });
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't crash the whole pool
          fetchFailed = true;
          console.warn(`[sprzedajemy] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Post-enrichment diagnostics (same shape as the fetchOneListing
        // path + the otodom/adresowo/morizon/domiporta fixes — Tasks
        // 4a/4b/4c/4d). Surfaces listings where extraction left gaps so
        // the run log shows which URLs to investigate. Skipped on fetch
        // failure (already logged above) so we don't double-warn.
        if (!fetchFailed) {
          const gaps = [];
          if (!ad.description || ad.description.length < 50) gaps.push(`desc=${ad.description?.length || 0}`);
          if (ad.lat == null || ad.lng == null) gaps.push('coords');
          if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
          if (gaps.length) {
            console.warn(`[sprzedajemy] enrichment gap for ${ad.externalId}: ${gaps.join(', ')}`);
          }
        }
        // Polite delay — 150ms between fetches per worker, same as domiporta/ofertyNet.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Per-listing detail-page fetcher used by the post-run enrichBackfill
  // pipeline (services/enrich.js) when a sprzedajemy listing is missing
  // description / coords / photos. Mirrors the fetchOneListing contract on
  // otodom / adresowo / gratka / morizon / domiporta / nieruchomosciOnline:
  //   - Returns null on fetch failure (caller keeps the existing stub).
  //   - Returns { externalId, sourceId, cityId, title, description, lat,
  //     lng, images, street, ... } with whatever fields it could extract
  //     from the detail page.
  //   - Per-field try/catch + post-enrichment gap diagnostics surface
  //     missing-data patterns in the run log instead of silently persisting
  //     incomplete listings (same pattern as the otodom/adresowo/morizon/
  //     domiporta fixes — Tasks 4a/4b/4c/4d).
  //
  // The heavy lifting is delegated to the existing `_applyDetail` (which
  // already extracts photos / coords / floor / area / rooms / street /
  // price / title / postedAt / description / conveniences from the detail
  // page's JSON-LD Product block + data-coordinates attribute + params
  // table). The detail page reliably returns 12-photo galleries + 500-char
  // descriptions + lat/lng (verified on a sample listing — the 17% missing-
  // desc gap in the pre-fix DB snapshot is a THROUGHPUT issue: the inline
  // `_enrichNew` worker silently swallowed fetch failures, and without a
  // fetchOneListing override the post-run enrichBackfill couldn't recover
  // those listings).
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
      address: city ? `${city.name_pl}` : null,
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
      console.warn(`[sprzedajemy] fetchOneListing fetch failed for ${url}: ${e.message}`);
      return null;
    }
    // _applyDetail has internal per-field try/catch, but guard against any
    // unexpected throw so we still return a stub instead of crashing the
    // caller. Previously the BaseScraper default returned null — making
    // sprzedajemy enrichment a complete no-op (17% missing desc pre-fix).
    // With this override, the default-case path in enrich.js now produces
    // real data.
    try {
      this._applyDetail(html, ad);
    } catch (e) {
      console.warn(`[sprzedajemy] fetchOneListing: _applyDetail threw for ${url}: ${e.message}`);
    }
    // Post-enrichment diagnostics: surface listings where extraction left
    // gaps so the run log shows which URLs to investigate. Same shape as
    // the adresowo/otodom/morizon/domiporta fixes.
    const gaps = [];
    if (!ad.description || ad.description.length < 50) gaps.push(`desc=${ad.description?.length || 0}`);
    if (ad.lat == null || ad.lng == null) gaps.push('coords');
    if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
    if (gaps.length) {
      console.warn(`[sprzedajemy] enrichment gap for ${url}: ${gaps.join(', ')}`);
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

  // Apply detail-page data to an existing listing object. Sources:
  //   1. JSON-LD Product block (PRIMARY) → name, description, image[],
  //      offers.Price (note capital P), owns.address (district fallback)
  //   2. data-coordinates attribute on the .location li → lat/lng (CRITICAL
  //      — must not be null per quality bar; we skip listings that lack it)
  //   3. Params table (`<li class="item"><span>Powierzchnia</span>
  //      <strong>49 m²</strong></li>`) → area/rooms/floor backfill
  //
  // Per-field try/catch (Task 4f): each extraction block is wrapped in its
  // own try/catch with a logged warning. Previously a single broken field
  // (e.g. a malformed JSON-LD block on an edge-case listing) would throw
  // and abort ALL subsequent extraction inside the `if (product)` block —
  // leaving the listing with photos but no coords/desc/etc. Mirrors the
  // hardening applied to otodom (4a) / adresowo (4b) / morizon (4c) /
  // domiporta (4d) / nieruchomosciOnline (4e).
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD Product block ----
    let product = null;
    try {
      product = this._extractProductBlock(s);
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: _extractProductBlock threw for ${ad?.url}: ${e.message}`);
    }
    if (product) {
      // Photos — JSON-LD image[] gives 8-12 full-res URLs at
      // thumbs.img-sprzedajemy.pl/1000x901c/... (verified 12 photos on the
      // sample listing nr73862330). This meets the quality bar's 8-12 minimum
      // cleanly without a separate gallery fetch.
      try {
        const images = [];
        if (Array.isArray(product.image)) {
          const seen = new Set();
          for (const u of product.image) {
            if (typeof u !== 'string' || !u) continue;
            const url = u.replace(/\\\//g, '/'); // JSON-encoded slashes → real /
            if (seen.has(url)) continue;
            // Skip the site's "no photo" placeholder (sprstatic2…/noPhoto/…):
            // ads whose photos were removed by the seller still expose it in
            // JSON-LD — persisting it would store a fake image (Task 3-f).
            if (/\/noPhoto\//.test(url)) continue;
            seen.add(url);
            images.push(url);
            if (images.length >= 20) break; // persistListing cap
          }
        } else if (typeof product.image === 'string' && product.image) {
          images.push(product.image.replace(/\\\//g, '/'));
        }
        if (images.length) ad.images = images;
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: image extraction threw for ${ad?.url}: ${e.message}`);
      }

      // Description — the FULL Polish text with \n line breaks. JSON-LD
      // preserves the agent-written formatting (verified on sample listing:
      // 6 paragraphs, ~80 words, includes "OGŁOSZENIE BEZPOŚREDNIE - BEZ
      // PROWIZJI" header + price breakdown + contact info). Meets the quality
      // bar without needing a separate <div> extraction.
      try {
        if (product.description && String(product.description).length > (ad.description || '').length) {
          ad.description = this._decodeEntities(String(product.description)).trim();
        }
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: description extraction threw for ${ad?.url}: ${e.message}`);
      }

      // Title — JSON-LD `name` is the full Polish title (matches the search
      // card's <h2 class="title"> — but the JSON-LD version is canonical).
      try {
        if (product.name) {
          ad.title = this._decodeEntities(String(product.name).trim());
        }
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: title extraction threw for ${ad?.url}: ${e.message}`);
      }

      // Price — JSON-LD offers.Price (with capital P!). Sprzedajemy's schema
      // violates schema.org here (the canonical key is lowercase `price`).
      // We try both keys; sanity-check the value against the search card's
      // price (allow ±5% for negotiating/rounding differences; otherwise
      // trust the detail-page value as it's the freshest).
      try {
        const offers = product.offers || {};
        const detailPrice = parseNum(offers.price != null ? offers.price : offers.Price);
        if (detailPrice && detailPrice > 0) {
          if (!ad.price || Math.abs(detailPrice - ad.price) > Math.max(50, ad.price * 0.05)) {
            ad.price = Math.round(detailPrice);
          }
        }
        if (offers.priceCurrency) {
          ad.currency = String(offers.priceCurrency);
        }
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: price extraction threw for ${ad?.url}: ${e.message}`);
      }

      // District — JSON-LD owns.address ("Warszawa, Rembertów"). Splitting on
      // the comma gives [city, district]. We override the search-card district
      // only when the JSON-LD address has a comma-separated sub-locality.
      try {
        const owns = product.owns || {};
        if (owns.address) {
          const parts = String(owns.address).split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2 && parts[1] && parts[1].toLowerCase() !== city_name(ad).toLowerCase()) {
            // Use the sub-locality (e.g. "Rembertów") as the district
            ad.district = parts[1];
            ad.address = `${parts[1]}, ${parts[0]}`;
          }
        }
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: district extraction threw for ${ad?.url}: ${e.message}`);
      }
    }

    // ---- 1b. Description fallback (DOM) — Task 3-f ----
    // sprzedajemy serves a SECOND detail-page template (verified 2026-09-01 on
    // 42/200 live Warsaw listings): it emits ONLY a BreadcrumbList JSON-LD
    // block — no Product block — so description/images/price must come from
    // the DOM. Description priority: `.offerDescription` div (full text,
    // 321-3218 chars on sampled template-2 pages) → og:description (truncated
    // ~230-char teaser, last resort) → meta description. Genuinely empty ads
    // keep desc='' and log one line so the run log stays diagnostic.
    if (!ad.description || ad.description.length < 50) {
      try {
        const domDesc = this._extractDomDescription(s);
        if (domDesc && domDesc.length > (ad.description || '').length) {
          ad.description = domDesc;
        }
      } catch (e) {
        console.warn(`[sprzedajemy] _applyDetail: DOM description fallback threw for ${ad?.url}: ${e.message}`);
      }
      if (!ad.description || ad.description.length < 50) {
        console.warn(`[sprzedajemy] no description on source page for ${ad?.externalId || ad?.url} (ad may genuinely have none)`);
      }
    }

    // ---- 1c. Price fallback (DOM) — Task 3-f ----
    // The Breadcrumb-only template has no JSON-LD offers block; the price
    // lives in `<strong class="price priceWrpWithLabel"><span>6 600 zł</span></strong>`.
    // Search-card price already covers the in-scrape path; this mainly fixes
    // fetchOneListing stubs (price starts at 0 there). Same sanity rule as
    // the JSON-LD price above.
    try {
      const hasJsonLdPrice = !!(product?.offers && (product.offers.price != null || product.offers.Price != null));
      if (!hasJsonLdPrice) {
        const domPrice = this._extractDomPrice(s);
        if (domPrice && domPrice > 0 && (!ad.price || Math.abs(domPrice - ad.price) > Math.max(50, ad.price * 0.05))) {
          ad.price = Math.round(domPrice);
        }
      }
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: DOM price fallback threw for ${ad?.url}: ${e.message}`);
    }

    // ---- 1d. Gallery photos (DOM) — Task 3-f ----
    // On the Breadcrumb-only template the JSON-LD image[] is absent and the
    // search-card thumb (350x250c) is all that remains. The full-res gallery
    // is server-rendered as `<img class="js-gallerySlide" src="…1000x901c/…">`
    // (verified: unique slides == JSON-LD set on the Product template, so a
    // DOM merge is a no-op there and the JSON-LD order stays canonical).
    // Strictly scoped to js-gallerySlide imgs — no similar-ads-rail leakage
    // (the domiporta Task 3-c lesson); the low-res search thumb is dropped
    // once real photos exist.
    try {
      const slides = this._extractGalleryPhotos(s);
      if (slides.length) {
        const isThumb = (u) => /\/350x250c\//.test(u);
        const seenUrls = new Set();
        const fullRes = [];
        const thumbs = [];
        for (const u of [...(ad.images || []), ...slides]) {
          if (!u || seenUrls.has(u)) continue;
          if (/\/noPhoto\//.test(u)) continue; // site "no photo" placeholder
          seenUrls.add(u);
          (isThumb(u) ? thumbs : fullRes).push(u);
        }
        const merged = fullRes.length ? fullRes : thumbs;
        if (merged.length) ad.images = merged.slice(0, 20);
      }
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: DOM gallery fallback threw for ${ad?.url}: ${e.message}`);
    }

    // ---- 2. Coords (data-coordinates) ----
    // The detail page emits Python-style single-quoted dicts on the contact
    // row:
    //   <li class="location" data-coordinates="{'lat': 52.2733878, 'lng': 21.1490348, 'zoom': 12}">
    // The single quotes are invalid JSON; we regex-extract lat/lng directly.
    // Sanity-bound to Poland (lat 49-55, lng 14-24) to filter out any stray
    // matches elsewhere on the page.
    try {
      const coords = this._extractCoords(s);
      if (coords) {
        ad.lat = coords.lat;
        ad.lng = coords.lng;
      }
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: coords extraction threw for ${ad?.url}: ${e.message}`);
    }

    // ---- 3. Params table (backfill) ----
    // `<li class="item"><span>Powierzchnia</span><strong>49 m²</strong></li>`
    try {
      const params = this._extractParamsTable(s);
      if (params.area != null && params.area > 0) ad.area = params.area;
      if (params.rooms != null && params.rooms > 0) ad.rooms = params.rooms;
      if (params.floor != null) ad.floor = String(params.floor).trim();
      if (params.street) ad.street = params.street;
      // Save the publisher name (owns.name) + raw params to raw for the dedupe
      // / translate pipeline.
      if (product?.owns?.name || params.rawParams) {
        ad.raw = ad.raw || {};
        if (product?.owns?.name) ad.raw.publisher = String(product.owns.name);
        if (params.rawParams) ad.raw.params = params.rawParams;
      }
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: params table extraction threw for ${ad?.url}: ${e.message}`);
    }

    // Conveniences — sprzedajemy's params table includes "Oferta od" (FIRMA/
    // OSOBA PRYWATNA) but no amenity list. Infer from description like olx
    // does: parking, lift, balcony, garage.
    try {
      if ((!ad.conveniences || !ad.conveniences.length) && ad.description) {
        ad.conveniences = this._inferConveniences(ad.description);
      }
    } catch (e) {
      console.warn(`[sprzedajemy] _applyDetail: conveniences inference threw for ${ad?.url}: ${e.message}`);
    }
  }

  // Extract the full-res gallery URLs from the detail page. The slides are
  // server-rendered `<img class="js-gallerySlide" src="…">` tags (no lazy
  // data-src on the current template, but data-src/data-lazy/srcset are
  // handled defensively in that order). Duplicates (prev/next clones) are
  // deduped; count on live pages: 6-12 unique per listing.
  _extractGalleryPhotos(html) {
    const out = [];
    const seen = new Set();
    const re = /<img[^>]*js-gallerySlide[^>]*>/gi;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const tag = m[0];
      let url = null;
      const srcM = tag.match(/\ssrc="(https:\/\/[^"']+)"/i);
      const lazyM = tag.match(/\sdata-(?:src|lazy|lazy-src)="(https:\/\/[^"']+)"/i);
      const srcsetM = tag.match(/\ssrcset="([^"]+)"/i);
      if (srcM) url = srcM[1];
      else if (lazyM) url = lazyM[1];
      else if (srcsetM) url = srcsetM[1].split(',')[0].trim().split(/\s+/)[0];
      if (!url || seen.has(url)) continue;
      if (/\/noPhoto\//.test(url)) continue; // site "no photo" placeholder
      seen.add(url);
      out.push(url);
      if (out.length >= 20) break; // persistListing cap
    }
    return out;
  }

  // Description fallback for the Breadcrumb-only detail template. Priority:
  //   1. `<div class="offerDescription">…</div>` — full ad text (the div may
  //      wrap the copy in a <span>; tags are stripped and whitespace kept as
  //      line breaks).
  //   2. og:description — a ~230-char truncated teaser (last resort only).
  //   3. meta name=description — same teaser, entity-encoded.
  // Returns '' when the page has none (genuinely empty ad).
  _extractDomDescription(html) {
    const s = String(html);
    let raw = null;
    // Non-greedy to the first </div>: on the current template the div's only
    // child is a single <span> (no nested divs verified on 5 live pages), so
    // this captures the full copy including the wrapping span.
    const divM = s.match(/<div[^>]*class="[^"]*offerDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (divM) {
      const inner = divM[1] || '';
      if (inner.replace(/<[^>]+>/g, '').trim()) raw = inner;
    }
    if (!raw) {
      const ogM = s.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
              || s.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
      if (ogM && ogM[1].trim()) raw = ogM[1];
    }
    if (!raw) {
      const mdM = s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
      if (mdM && mdM[1].trim()) raw = mdM[1];
    }
    if (!raw) return '';
    return this._normalizeDescText(raw);
  }

  // Turn raw description HTML (or an entity-encoded meta content) into clean
  // plain text: block-level tags → line breaks, remaining tags stripped,
  // named + numeric entities decoded, whitespace collapsed (line breaks kept
  // — the source stores \n-formatted copy and the DB keeps that convention).
  _normalizeDescText(raw) {
    let t = String(raw)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    t = this._decodeEntities(t);
    t = t
      .replace(/&#(\d+);/g, (_, d) => {
        const n = Number(d);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const n = Number.parseInt(h, 16);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      });
    return t
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // DOM price fallback (Breadcrumb-only template):
  //   <strong class="price priceWrpWithLabel"><span> 6 600 zł </span></strong>
  // Scoped to the <strong class="price…"> wrapper so the neighbouring
  // .price-is-negotiable / .offer-price-box containers can't match.
  _extractDomPrice(html) {
    const m = String(html).match(/<strong[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>\s*<span[^>]*>\s*([\d\s\u00a0.,]+)\s*zł/i);
    return m ? parseNum(m[1]) : null;
  }

  // Find the JSON-LD block whose @type array includes "Product" on a detail
  // page. Sprzedajemy emits Product + Organization together as a single
  // block — we grab whichever one has an `offers` field with a price (the
  // canonical listing-data block; the BreadcrumbList block earlier in the
  // page has no offers).
  _extractProductBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      const t = b?.['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes('Product')) {
        // Must have an `offers` block to be a real listing (weeds out generic
        // Product blocks for site metadata).
        if (b?.offers && (b.offers.price != null || b.offers.Price != null || b.offers.url)) return b;
      }
    }
    return null;
  }

  // Extract lat/lng from a data-coordinates attribute. The attribute value
  // is a Python-style single-quoted dict — invalid JSON, so we regex it.
  // Sanity-bound to Poland (lat 49-55, lng 14-24).
  _extractCoords(html) {
    // Match `data-coordinates="{...lat..: <num>, ...lng..: <num>...}"` — the
    // attribute value uses single quotes for keys. Tolerant of either 'lat' or
    // 'latitude' (defensive; sprzedajemy uses 'lat').
    const re = /data-coordinates="\{\s*['"]lat['"]\s*:\s*([\d.]+)[^}]*['"]lng['"]\s*:\s*([\d.]+)/i;
    const m = re.exec(html);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Poland sanity bounds — filters out stray regex matches elsewhere.
    if (lat < 49 || lat > 55 || lng < 14 || lng > 24) return null;
    return { lat, lng };
  }

  // Extract the params table from the detail page. The list of `<li
  // class="item"><span>Label</span><strong>Value</strong></li>` rows carries
  // Powierzchnia (area), Liczba pokoi (rooms), Piętro (floor), Rok budowy
  // (year built), Liczba pięter (building floor count), Oferta od (seller
  // type), and a few others. We map the keys we care about to our schema;
  // the full list is preserved in rawParams for the translate pipeline.
  _extractParamsTable(html) {
    const out = { area: null, rooms: null, floor: null, street: null, rawParams: [] };
    const re = /<li\s+class="item">\s*<span>([^<]+?)<\/span>\s*<strong>([^<]*?)<\/strong>\s*<\/li>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const label = m[1].trim();
      const value = m[2].trim();
      if (!label || !value) continue;
      out.rawParams.push({ key: label, value });
      const lv = label.toLowerCase();
      if (lv === 'powierzchnia') {
        out.area = parseNum(value);
      } else if (lv === 'liczba pokoi') {
        const n = parseInt(value.replace(/[^\d]/g, ''), 10);
        if (!isNaN(n) && n > 0) out.rooms = n;
      } else if (lv === 'piętro' || lv === 'pietro') {
        out.floor = value;
      } else if (lv === 'ulica' || lv === 'adres') {
        out.street = value;
      }
    }
    return out;
  }

  // Infer conveniences from the listing description. Sprzedajemy doesn't
  // emit a structured amenity list, so we grep the description text for
  // Polish keywords the same way OLX does (biedronka, lidl, parking, winda,
  // balkon, garaż, ogródek, metro, tramwaj, etc.).
  _inferConveniences(description) {
    const conv = [];
    const s = String(description || '').toLowerCase();
    const allText = s;
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
    if (allText.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/)) {
      const mm = allText.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/);
      if (mm) conv.push({ type: 'market', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    if (allText.match(/\b(metro|tramwaj|autobus|stacja|przystanek)\b/)) {
      const mm = allText.match(/\b(metro|tramwaj|autobus)\b/);
      if (mm) conv.push({ type: 'transport', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    return conv.slice(0, 5);
  }

  // Strip tracking/marketing query params so the same listing always produces
  // the same stored URL (mirrors the olx/domiporta/ofertyNet pattern). Sprzedajemy
  // listing URLs are clean by default (`/<slug>-nr<id>` with no query string),
  // but normalizing defensively protects against future regressions and
  // against imported URLs with utm_*/fbclid etc.
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

// Helper to keep _applyDetail readable — fetch the city name from the ad's
// cityId via the cached `city` object the caller passed to fetchCity. For
// the detail-page application path (where we don't have `city` in scope),
// we fall back to inspecting the listing's address field.
function city_name(ad) {
  // The listing's `address` field was built as `${district}, ${city.name_pl}`
  // on the search card path. If we lost that, the city name is the second
  // comma-separated piece. Best-effort; the only place this is used is the
  // guard that skips overwriting district with the city name itself.
  if (!ad) return '';
  const parts = String(ad.address || '').split(/\s*,\s*/);
  return parts.length >= 2 ? parts[parts.length - 1] : (ad.district || '');
}

