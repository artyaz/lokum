// oferty.net scraper — Agora Group sister of Morizon/Gratka, but old-school
// server-rendered HTML (no JSON-LD offers[] blob, no __NUXT_DATA__). Plain
// `fetch()` is enough; no anti-bot, no Playwright fallback needed.
//
// Site layout (verified 2026-08-30 via curl + z-ai page_reader on live pages):
//
//   Search:  https://www.oferty.net/mieszkania,warszawa?page=N
//            Pagination preserves the city path (e.g. ?page=2..69).
//            IMPORTANT: the path returns MIXED sale + rent listings (the
//            site's `ps[transaction]=2` query param does NOT actually
//            filter — it gets ignored by the server). We post-filter rows
//            client-side by URL pattern: `mieszkanie-na-wynajem-` = rent,
//            `mieszkanie-na-sprzedaz-` = sale (skipped).
//            ~20 listings/page, 69 pages for Warszawa = 1380 total listings,
//            ~30-50% rent depending on the day.
//
//   Detail:  https://www.oferty.net/mieszkanie-na-wynajem-<slug>,<id>
//            Server-renders:
//              - JSON object embedded mid-page: `{"country":"pl","residence_area":N,
//                "floor":N,"number_of_rooms":N,"price":N,"street":"...","district":"...",
//                "city":"...","quarter":"...","photo_url":"https://imgN.staticoferty.net.pl/
//                thumbnail/<base64>/...","transaction":"wynajem",...}` — primary source
//                for area/rooms/floor/street/district.
//              - <div class="GoogleMap" id="property-map" data-lat="52.236" data-lng="20.9689">
//                — primary source for coords.
//              - <div id="description" class="description">…</div> — full Polish text.
//              - <meta property="og:image" content=".../thumbnail/<base64>/..."> +
//                <li class="imageN"><img data-original=".../thumbnail/<base64>/...">
//                — gallery photos (base64 decodes to the original media.domy.pl URL).
//              - <dl><dt>Piętro:</dt><dd>2</dd>…</dl> — extra params (building type,
//                year built, etc.) — used to backfill floor/building_type if missing
//                from the JSON object.
//              - "Data dodania: DD-MM-YYYY" — listing's addedAt (parsed to ISO).
//
//   Photos:  Each thumbnail URL on oferty.net is base64-encoded:
//              https://imgN.staticoferty.net.pl/thumbnail/<b64>/<w>/<h>/<variant>/thumbnail.jpg
//            Decoding <b64> yields the original http://media.domy.pl/img/...jpg URL
//            (with an optional `#v=...` cache-bust suffix we strip). We upgrade to
//            https + drop the suffix. The pattern mirrors gratka's `decodeThumbUrl`
//            helper but lives here because the b64 format differs (no `thumbs.cdngr.pl`,
//            different base64 payload shape).
//
// Quality bar (per Task D brief):
//   - lat/lng: <div class="GoogleMap" data-lat data-lng> (must not be null)
//   - photos: og:image + <li class="imageN"> (typically 8-15/listing)
//   - description: full Polish text from <div id="description">
//   - price: PLN/monthly from JSON object's `price`
//
// Inventory note: 608 336 portal-wide listings (per C2 research). Warszawa
// alone shows ~1380 mixed sale+rent listings across 69 pages. With
// MAX_PAGES=30 (600 listings) and ~30-50% rent fraction, we walk ~180-300
// rent listings per fetch cycle. The detail-page enrichment pool (4 workers)
// processes ~100-200 new listings per cycle.
//
// Dedupe overlap (per C2 research): oferty.net is owned by Agora Group, the
// same parent as Morizon + Gratka — high overlap expected with morizon.js +
// gratka.js results. The dedupe pipeline (services/dedupe.js) catches these
// via geo + area + rooms fingerprint.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 10;
// 20 listings/page → 30 pages = ~600 listings/city/fetch. With Warszawa
// returning ~30-50% rent listings per page, that yields ~180-300 rent
// listings per cycle. Pairs with the 3×/day recommended schedule (B8) so
// each fetch catches every rent listing added in the past ~8h with margin.
const MAX_PAGES = 30;
// Page caps: 20 mixed (sale + rent). When we hit a short page (<10 listings)
// we treat it as the last page. Threshold = HALF of OFFERS_PER_PAGE so a
// small natural fluctuation (page N returns 19 because 1 delisted) doesn't
// trigger a false break. The true last page returns ~14 (verified on
// /mieszkania,warszawa?page=69).
const OFFERS_PER_PAGE = 20;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Pre-fix a single failure did `break` and silently
// dropped pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// Cap the number of detail-page fetches per cycle. With ~300 rent listings
// per walk and 4-worker pool, this caps at ~300 detail fetches per cycle —
// roughly 2-3 minutes at 500ms/fetch. Aligned with gratka's ENRICH_LIMIT.
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value
// as gratka/morizon/adresowo for parity — 4 workers strikes the right
// balance between throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;

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

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Polish number parsing: "1 580 000" (space thousand separator), "83,33" (decimal comma).
// Returns a Number (or null on failure). Mirrors adresowo.js's parseNum but
// handles the longer space-separated values oferty.net uses for prices.
function parseNum(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Decode the base64 payload embedded in oferty.net thumbnail URLs to the
// original full-res media.domy.pl URL. Pattern:
//   https://imgN.staticoferty.net.pl/thumbnail/<b64>/<w>/<h>/<variant>/thumbnail.jpg
// → <b64> decodes to e.g.:
//   http://media.domy.pl/img/zdjecia/gmg464671/1/gmg464671_mw_14_3.jpg#v=1_4117579551
// We strip the `#v=...` cache-bust suffix and upgrade http→https.
// Returns null if the input isn't a valid base64-encoded image URL.
//
// IMPORTANT: the base64 alphabet includes `/` (a valid base64 char), so the
// regex `/thumbnail/([A-Za-z0-9+/=]+)` would GREEDILY capture across the
// `/<w>/<h>/<variant>/thumbnail.jpg` size suffix and decode garbage. We use
// a non-greedy capture with a lookahead `(?=/\d)` that stops at the first
// `/digit` (the size prefix like `/80/`, `/1200/`). This handles both padded
// b64 (`...==/80/...`) and unpadded b64 (`...Nw/80/...`) correctly.
function decodeThumbToOriginal(url) {
  if (!url) return null;
  const m = String(url).match(/\/thumbnail\/([A-Za-z0-9+/=]+?)(?=[/]\d)/);
  if (!m) return null;
  const b64 = m[1];
  // Cheap base64 sanity gate (mirrors gratka's decodeNuxtPhotoB64).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let decoded;
  try {
    // Pad if necessary (b64 length must be a multiple of 4 chars before
    // Buffer.from() can decode it cleanly). The non-greedy capture above
    // sometimes returns a b64 segment without its trailing `==` padding
    // when the URL has no `==` at all (rare for oferty.net but defensive).
    const pad = (4 - (b64.length % 4)) % 4;
    const padded = pad ? b64 + '='.repeat(pad) : b64;
    decoded = Buffer.from(padded, 'base64').toString('utf8');
  } catch { return null; }
  // Strip the cache-bust fragment: `...jpg#v=1_4117579551`
  if (decoded.includes('#')) decoded = decoded.split('#')[0];
  // Upgrade http → https (media.domy.pl serves both; https is preferred).
  if (decoded.startsWith('http://')) decoded = 'https://' + decoded.slice(7);
  // Must end in an image extension to be a real photo URL (filters out
  // logo / agent avatar / member-icon URLs that share the b64 pattern).
  if (!/\.(?:jpg|jpeg|png|webp)$/i.test(decoded)) return null;
  return decoded;
}

// "Data dodania: 27-08-2026" (DD-MM-YYYY Polish format) → ISO string.
// Returns null if no parseable date is found.
function parsePostedAt(text) {
  if (!text) return null;
  const t = String(text).trim();
  const m = t.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export class OfertyNetScraper extends BaseScraper {
  // IMPORTANT: streaming disabled (same fix pattern as gratka/adresowo).
  // When `supportsStreaming = true`, the runner used the `onListing` callback
  // path which emits each listing as it's parsed from the search cards — but
  // ofertyNet's detail-page enrichment (`_enrichNew`, which fetches photos
  // / full description / coords / postedAt) was conditional on `!onListing`
  // and so NEVER ran in streaming mode. Disabling streaming keeps peak memory
  // slightly higher (~5 MB for ~300 listings × 5 KB payload) but ensures the
  // enrich step actually runs.
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'oferty-net', baseUrl: 'https://www.oferty.net' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('OFERTYNET_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // We do NOT add `ps[transaction]=2` — the server ignores it (verified
      // live) and serves the same mixed sale+rent feed regardless. Filtering
      // happens client-side via the URL pattern `mieszkanie-na-wynajem-`.
      if (filters.maxPrice != null) params.set('ps[price_to]', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('ps[price_from]', String(filters.minPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkania,${cityPath}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[oferty-net] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[oferty-net] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
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
        if (page === 1) console.warn(`[oferty-net] ${city.slug}: no cards on page 1`);
        else console.log(`[oferty-net] ${city.slug} page ${page}: empty page — stopping`);
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
        `[oferty-net] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have 20 cards each (OFFERS_PER_PAGE);
      // the true last page returns ~14 (verified live on /mieszkania,warszawa?page=69).
      // Use HALF of OFFERS_PER_PAGE as the threshold so a natural fluctuation
      // of ±1-2 cards doesn't trigger a false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[oferty-net] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse listing cards from the search results HTML. Each listing row is a
  // <tr class="property [highlight] [oddRow|evenRow]" onclick="window.location='URL'">
  // The cell_* <td>s hold area / rooms / price / added_at.
  // We SKIP sale listings here — the URL pattern `mieszkanie-na-sprzedaz-`
  // distinguishes them from rent (`mieszkanie-na-wynajem-`).
  _parseCards(html, city) {
    const out = [];
    // Split on <tr class="property — every listing row starts with this marker.
    const chunks = String(html).split('<tr class="property').slice(1);
    for (const chunkRaw of chunks) {
      try {
        // Take enough of the chunk to capture all <td>s without grabbing the
        // next row's content (each row is ~1.5 KB).
        const chunk = chunkRaw.slice(0, 5000);

        // Detail URL — embedded in the row's onclick + the location <a href>.
        const onclickM = chunk.match(/onclick="window\.location\s*=\s*'([^']+)'/);
        if (!onclickM) continue;
        const url = onclickM[1];

        // Rent filter: only keep `mieszkanie-na-wynajem-` listings (skip sale).
        // The site returns MIXED sale+rent listings on every page (the
        // `ps[transaction]` filter is ignored server-side — verified live).
        if (!/\/mieszkanie-na-wynajem-/.test(url)) continue;

        // External id = the trailing numeric id after the last comma in the URL.
        const idM = url.match(/,(\d+)(?:[?#]|$)/);
        if (!idM) continue;
        const externalId = idM[1];

        // Location text from the <a title="..."> attribute — e.g.
        // "mieszkanie na wynajem Warszawa, Młynów". Splits to {city, district}.
        const locM = chunk.match(/<a\s+title="([^"]+)"[^>]*href="[^"]*mieszkanie-na-wynajem-[^"]+"/i);
        let district = city.name_pl;
        let titleDistrict = null;
        if (locM) {
          // Title format: "mieszkanie na wynajem <City>, <District>"
          // Strip the prefix, then split on the comma.
          const parts = locM[1].replace(/^mieszkanie\s+na\s+wynajem\s+/i, '').split(/\s*,\s*/);
          if (parts.length >= 2) {
            titleDistrict = parts.slice(1).join(', ').trim();
          } else if (parts.length === 1) {
            titleDistrict = parts[0].trim();
          }
          if (titleDistrict && titleDistrict.toLowerCase() !== city.name_pl.toLowerCase()) {
            district = titleDistrict;
          }
        }

        // Numeric fields from <td class="cell_*">.
        const areaM = chunk.match(/<td class="cell_area">([\d,\s\u00a0]+)\s*m²/);
        const roomsM = chunk.match(/<td class="cell_rooms">(\d+)<\/td>/);
        const priceM = chunk.match(/<td class="cell_price">([\d\s\u00a0]+)<\/td>/);
        // added_at: "HH:MM<br/>YYYY-MM-DD" — gives us postedAt without needing
        // the detail page (the page also exposes "Data dodania" in DD-MM-YYYY,
        // but the search-page cell is already in ISO-friendly format).
        const addedM = chunk.match(/<td class="cell_added_at">\s*(\d{1,2}:\d{2})\s*<br\/>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);

        // Cover image — the row's only <img data-original="..."> is the cover.
        // Decode the base64 payload to the original media.domy.pl URL.
        const imgM = chunk.match(/<img[^>]+data-original="(https:\/\/img\d+\.staticoferty\.net\.pl\/thumbnail\/[^"]+)"/);
        let coverUrl = null;
        if (imgM) coverUrl = decodeThumbToOriginal(imgM[1]);

        // Title — human-readable summary built from available fields. Mirrors
        // adresowo's pattern ("Mieszkanie — <district>, <street>").
        const price = parseNum(priceM ? priceM[1] : '');
        const area = parseNum(areaM ? areaM[1] : '');
        const rooms = roomsM ? parseInt(roomsM[1], 10) : null;
        const postedAt = addedM ? `${addedM[2]}T${addedM[1].padStart(5, '0')}:00Z` : null;

        // Skip listings with no price (rare but possible — promoted header
        // rows sometimes lack price). Mirrors adresowo's `a.price > 0` filter.
        if (!price || price <= 0) continue;

        // Short title — the search card doesn't expose a real "title" field
        // (only the location span). Build one from district + city like the
        // other scrapers do.
        const title = `Mieszkanie na wynajem — ${district}, ${city.name_pl}`;

        out.push({
          externalId,
          sourceId: SOURCE_ID,
          cityId: city.id,
          title,
          description: '',
          price: Math.round(price),
          currency: 'PLN',
          rooms,
          area,
          floor: null, // backfilled from detail-page JSON object in _enrichNew
          district,
          street: null, // backfilled from detail-page JSON object
          address: `${district}, ${city.name_pl}`,
          lat: null,
          lng: null,
          url: this._normalizeUrl(url),
          postedAt,
          images: coverUrl ? [coverUrl] : [],
          conveniences: [],
          raw: { url, searchDistrict: titleDistrict }
        });
      } catch {}
    }
    return out.filter(a => a.price > 0 && a.externalId);
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full description, coords, gallery photos,
  // street, floor, and the JSON object's area/rooms/district (overrides
  // the search-card values when more precise — e.g. the card shows "42 m²"
  // but the JSON object has "42,2").
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
    console.log(`[oferty-net] enriching ${fresh.length} listings (photos/desc/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true, timeout: 20000 });
          self._applyDetail(html, ad);
        } catch (e) {
          // Don't crash the whole pool — log and move on.
          console.warn(`[oferty-net] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as gratka.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Fetches:
  //   - JSON object (street, district, area, rooms, floor, photo_url cover)
  //   - Gallery photos (og:image + <li class="imageN"> data-original)
  //   - Description (<div id="description">)
  //   - Coords (<div class="GoogleMap" data-lat data-lng>)
  //   - Params (<dl><dt>Label:</dt><dd>Value</dd></dl>) — floor + building type
  //   - postedAt — kept from the search-card cell_added_at if present; falls
  //     back to "Data dodania: DD-MM-YYYY" on the detail page if missing.
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON object (primary source of truth for street/district) ----
    // The page embeds `{"country":"pl","residence_area":N,...,"city":"Warszawa"}`
    // as a JS object literal. Extract with a tolerant regex that handles
    // unicode escapes (\uXXXX) and JSON-encoded slashes (\/).
    const jsonM = s.match(/\{"country":"pl"[\s\S]*?"city":"[^"]+"\}/);
    let json = null;
    if (jsonM) {
      try {
        // Unescape JSON-encoded slashes (\/ → /) and parse.
        json = JSON.parse(jsonM[0].replace(/\\\//g, '/'));
      } catch {}
    }
    if (json) {
      // Street — prefer JSON's `street` over the URL slug (more readable).
      if (json.street && !ad.street) {
        ad.street = json.street;
      }
      // District — JSON's `district` is more precise than the search-card
      // location text (e.g. "Mokotów" vs "Mokotów Ksawerów"). Override the
      // search-card district if the JSON has a cleaner value.
      if (json.district) {
        ad.district = json.district;
      }
      // Area — JSON's `residence_area` is the precise m² (e.g. 42 vs the
      // card's rounded "42"). Replace if the JSON value is more precise.
      if (json.residence_area != null) {
        ad.area = Number(json.residence_area);
      }
      // Rooms.
      if (json.number_of_rooms != null) {
        ad.rooms = Number(json.number_of_rooms);
      }
      // Floor.
      if (json.floor != null) {
        ad.floor = String(json.floor);
      }
      // Price sanity check — if the JSON price disagrees with the search
      // card's parsed price by more than 5%, prefer the JSON value (the
      // search card sometimes strips trailing decimals).
      if (json.price != null) {
        const jsonPrice = Math.round(Number(json.price));
        if (jsonPrice > 0 && Math.abs(jsonPrice - ad.price) > Math.max(50, ad.price * 0.05)) {
          ad.price = jsonPrice;
        }
      }
      // Conveniences — mark direct-owner listings ("owner":"właściciel")
      // as Bez pośredników (same convention as adresowo).
      if (json.owner && /właściciel|wlasciciel/i.test(json.owner)) {
        ad.conveniences = [{ type: 'direct', label: 'Bez pośredników' }];
      }
    }

    // ---- 2. Coords (lat/lng) ----
    // <div class="GoogleMap" id="property-map" data-id="p123" data-lat="52.236" data-lng="20.9689" data-zoom="14">
    const latM = s.match(/<div[^>]*class="GoogleMap"[^>]*data-lat="([\d.]+)"[^>]*data-lng="([\d.]+)"/i);
    if (latM) {
      const lat = parseFloat(latM[1]);
      const lng = parseFloat(latM[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat > 40 && lat < 60 && lng > 10 && lng < 30) {
        ad.lat = lat;
        ad.lng = lng;
      }
    }

    // ---- 3. Gallery photos (og:image + <li class="imageN"> src/data-original) ----
    // Primary: <meta property="og:image"> = cover photo (largest variant).
    // Secondary: <li class="imageN"><img src="..." OR data-original="..."> =
    //   gallery thumbs. The page actually has TWO sets of <li class="imageN">
    //   — one eager-loaded (with `src=`) for the visible carousel, and one
    //   lazy-loaded (with `data-original=`) for the thumbnails nav. Both
    //   decode to the same set of original media.domy.pl URLs. We capture
    //   EITHER attribute and dedupe by decoded URL.
    //
    // Each thumbnail URL is b64-encoded; decodeThumbToOriginal handles the
    // http→https upgrade + cache-bust suffix strip + image-extension filter.
    // Logos + agent avatars share the b64 pattern but live under /logo/ or
    // /uzytkownicy/ paths — filter those out.
    const photos = [];
    const seenUrls = new Set();
    const ogM = s.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (ogM) {
      const decoded = decodeThumbToOriginal(ogM[1]);
      if (decoded && !decoded.includes('/logo/') && !decoded.includes('/uzytkownicy/')) {
        seenUrls.add(decoded);
        photos.push(decoded);
      }
    }
    // Gallery thumbs — capture `src` OR `data-original` (the page uses one
    // or the other depending on carousel vs thumbnails set). Preserve the
    // `imageN` order so the gallery sequence matches what the page displays.
    const galleryMatches = [...s.matchAll(
      /<li\s+class="image(\d+)"[^>]*>[\s\S]*?<img[^>]+(?:src|data-original)="(https:\/\/img\d+\.staticoferty\.net\.pl\/thumbnail\/[^"]+)"/gi
    )];
    galleryMatches.sort((a, b) => parseInt(a[1], 10) - parseInt(b[1], 10));
    for (const m of galleryMatches) {
      const decoded = decodeThumbToOriginal(m[2]);
      if (!decoded || seenUrls.has(decoded)) continue;
      if (decoded.includes('/logo/') || decoded.includes('/uzytkownicy/')) continue;
      seenUrls.add(decoded);
      photos.push(decoded);
    }
    if (photos.length) ad.images = photos.slice(0, 20);

    // ---- 4. Description (full Polish text) ----
    // <div class="description" id="description">...</div>
    const descM = s.match(/<div[^>]*class="description"[^>]*id="description"[^>]*>([\s\S]*?)<\/div>\s*<div/i);
    if (!descM) {
      // Fallback: just close on </div> after the description div opener.
      const altM = s.match(/<div[^>]*id="description"[^>]*>([\s\S]*?)<\/div>/i);
      if (altM) {
        const d = stripTags(altM[1]);
        if (d && d.length > (ad.description || '').length) ad.description = d;
      }
    } else {
      const d = stripTags(descM[1]);
      if (d && d.length > (ad.description || '').length) ad.description = d;
    }

    // ---- 5. Params (<dl><dt>Label:</dt><dd>Value</dd></dl>) ----
    // Used to backfill floor (when missing from JSON) and to populate the
    // raw.params array for downstream translation by services/translate.js.
    const params = [];
    for (const m of s.matchAll(/<dt\s*>\s*([^<:]+):\s*<\/dt>\s*<dd\s*>\s*([^<]*)<\/dd>/g)) {
      const label = m[1].trim();
      const value = m[2].trim();
      if (!label || !value) continue;
      params.push({ key: label, name: label, value });
    }
    if (params.length) ad.raw.params = params.slice(0, 20);

    // Backfill floor from params if JSON object didn't have it.
    if (ad.floor == null) {
      const floorP = params.find(p => p.name === 'Piętro');
      if (floorP) ad.floor = floorP.value;
    }
    // Backfill area from params (Powierzchnia użytkowa) if JSON object didn't have it.
    if (ad.area == null) {
      const areaP = params.find(p => p.name === 'Powierzchnia użytkowa');
      if (areaP) {
        const n = parseNum(areaP.value);
        if (n != null) ad.area = n;
      }
    }
    // Backfill rooms from params (Liczba pokoi) if JSON object didn't have it.
    if (ad.rooms == null) {
      const roomsP = params.find(p => p.name === 'Liczba pokoi');
      if (roomsP) {
        const n = parseInt(roomsP.value, 10);
        if (!isNaN(n)) ad.rooms = n;
      }
    }

    // ---- 6. postedAt fallback (if missing from search card) ----
    // Detail page exposes "Data dodania: DD-MM-YYYY" — falls back to midnight UTC.
    if (!ad.postedAt) {
      const plM = s.match(/Data dodania[^<]*<[^>]*>\s*(\d{1,2}-\d{1,2}-\d{4})/);
      if (plM) {
        const parsed = parsePostedAt(plM[1]);
        if (parsed) ad.postedAt = parsed;
      }
    }

    // Update address if we now have a street.
    if (ad.street && ad.district) {
      ad.address = `${ad.street}, ${ad.district}, ${ad.raw?.city || 'Warszawa'}`;
    }
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. oferty.net's listing URLs are clean by default (no utm_*
  // in the /mieszkanie-na-wynajem-... path), but normalizing defensively
  // protects against future regressions and against imported URLs with
  // utm_*/fbclid etc. Mirrors B5 (adresowo), B2-5 (otodom), B3-11 (olx).
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
