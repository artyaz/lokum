// okolica.pl scraper — Warsaw-centric map-based rental portal (1 747 Warszawa
// wynajem listings, ~213 direct-from-owner subset). Plain fetch() works — no
// Cloudflare, no anti-bot, no Playwright fallback needed.
//
// Site layout (verified 2026-08-31 via curl + z-ai page_reader on live pages):
//
//   Markers API (THE map-data endpoint):
//     https://www.okolica.pl/markers/search/?browser[sort]=mod_desc&browser[transaction]=W
//       &browser[property]=mieszkanie&browser[query]=<City>, <Voivodeship>
//       &browser[mode]=api&browser[noagency]=1&browser[agency]=1&browser[aktualnosc]=&browser[distance]=
//
//     Returns ONE JSON blob for the WHOLE city bounds (no pagination):
//       {"bounds": ["52.0978767", "20.8512898", "52.3679992", "21.2710984"],
//        "markers": [[52.23591, 21.016534, "57306-W-129_14727_OMW", "W/1", 2], ...]}
//     Each marker row is `[lat, lng, external_id, "W/1", 2]` — compact, 79 KB
//     for ~1 742 Warsaw listings. We call this ONCE per fetchCity() and build
//     a {externalId → {lat, lng}} lookup the search-walk merges into each card.
//
//   Search HTML (paginated listing cards with rich data):
//     https://www.okolica.pl/mieszkanie/wynajme/<city>/?page=N
//       e.g. https://www.okolica.pl/mieszkanie/wynajme/warszawa/?page=2
//       40 cards/page; ~44 pages for Warszawa = 1 742 total listings.
//       The search card itself contains: externalId (section.data-id),
//       detail URL (/offer/show/<external_id>/formular), title (h2), address
//       (a.property-address → "Warszawa, Powiśle, Solec"), price
//       (li > span.price "2 300" + " zł"), rooms (li "Pokoje: 1"), area
//       (li > span "36" + " m²"), floor (li "Piętro: 7"), 8-12 photo thumbs
//       (li > img src=.../media/cache/list/property/...jpg + srcset=.../list2x/...)
//       plus a relative "added" time stamp (li > span.added_1 "23 min temu").
//
//     Direct-from-owner subset URL: /mieszkanie/wynajme/bezposrednio/<city>/
//       — 213 listings for Warszawa. We don't restrict the walk to this URL
//       (we'd lose 88% of the inventory); we walk the all-listings URL and
//       tag direct ones via the detail page's <div class="ownerType"> text.
//
//   Detail:  https://www.okolica.pl/offer/show/<external_id>/formular
//     Server-renders:
//       - ONE JSON-LD block @type=RealEstateListing with:
//           name (full title), description (TRUNCATED ~303 chars + "…"),
//           datePosted ("2026-08-29"), identifier (== external_id),
//           image (single thumbnail, cart_zoom variant), offers.price +
//           priceCurrency + url, mainEntityOfPage.
//       - <h1>title</h1> (full title, matches JSON-LD name).
//       - <ul class="property-data"><li>Cena za miesiąc:<span class="price">2 300</span> PLN</li>
//         <li>Powierzchnia:<span>36</span> m²</li>
//         <li>Liczba pokoi:<span>1</span></li>
//         <li>Piętro:<span>7</span></li></ul> — primary source for price/
//         rooms/area/floor on the detail page (the search card already has them,
//         but the detail block is the source of truth when enrichment runs).
//       - <div id="map" data-lat="52.236440" data-lng="21.027420"> — coords.
//         Used as a fallback when the markers/search API returned null for the
//         listing (extremely rare — markers/search has full city coverage).
//       - <div class="desc">Opis lokalu:<br />…full Polish text with <br />…</div>
//         — full description (the JSON-LD `description` is a 303-char truncation).
//       - <div class="ownerType">Bezpośrednio</div> — direct-from-owner marker
//         ("Bezpośrednio" = direct; "Agencja" = agency).
//       - Photo gallery: <img src="https://www.okolica.pl/media/cache/cart/property/...">
//         plus srcset="https://www.okolica.pl/media/cache/cart2x/property/...">,
//         with the og:image using `cart_zoom` (largest variant). We collect
//         `cart2x` URLs (preferred) + `cart_zoom` for the hero, deduped by the
//         canonical /property/<hash>.jpg path.
//
// Quality bar (per Task D brief):
//   - lat/lng: markers/search API (first-class; data-lat/data-lng fallback)
//   - photos: 8-12 from search-card list2x thumbs; detail enrichment upgrades
//     to cart2x (same photos, higher resolution)
//   - description: full Polish text from <div class="desc"> on detail page
//   - price: PLN/monthly from JSON-LD offers.price (fallback to search card)
//
// Dedupe overlap (per C3 research): okolica.pl is independent (not part of the
// Morizon/Gratka/Agora oligopoly). Some overlap expected with olx/otodom
// direct-from-owner listings; the services/dedupe.js pipeline catches these
// via geo + area + rooms fingerprint.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 15;
// 40 listings/page × 30 pages = ~1 200 listings/city/fetch — ~69% of the
// 1 742-listing Warszawa inventory. Pairs with the 3×/day recommended
// schedule (B8) so each fetch catches every listing added in the past ~8h
// with margin to spare. B-pattern parity with domiporta/ofertyNet/
// nieruchomosciOnline.
const MAX_PAGES = 30;
// 40 listings per page (verified on live 2026-08-31 — 1 742 / 44 pages).
const OFFERS_PER_PAGE = 40;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2); // 20
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Pre-fix a single failure did `break` and silently
// dropped pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
// Cap the number of detail-page fetches per cycle. With ~1 200 listings per
// walk and 4-worker pool, this caps at ~300 detail fetches per cycle —
// roughly 3 minutes at 500ms/fetch. Aligned with domiporta's /
// nieruchomosciOnline's / tabelaofert's ENRICH_LIMIT.
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value
// as domiporta/gratka/morizon/adresowo/ofertyNet/tabelaofert for parity —
// 4 workers strikes the right balance between throughput and not hammering
// the source.
const ENRICH_CONCURRENCY = 4;

// City path map — lowercase city slug as it appears in the URL path. The
// markers/search endpoint also requires the city's voivodeship name in the
// query string ("Warszawa, Mazowieckie") so the geo-bounds resolve correctly.
const CITY_PATH = {
  warsaw:  { path: 'warszawa',  query: 'Warszawa, Mazowieckie' },
  krakow:  { path: 'krakow',    query: 'Kraków, Małopolskie' },
  wroclaw: { path: 'wroclaw',  query: 'Wrocław, Dolnośląskie' },
  gdansk:  { path: 'gdansk',    query: 'Gdańsk, Pomorskie' },
  poznan:  { path: 'poznan',    query: 'Poznań, Wielkopolskie' }
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "2 300" (space thousand separator, sometimes \u00a0),
// "36,1" (decimal comma). Returns a Number (or null on failure). Mirrors
// domiporta.js / tabelaofert.js's parseNum but is liberal about whitespace
// and currency markers — okolica.pl uses bare "<price> PLN" / "<price> zł"
// in the JSON-LD offers.price field ("2300.00") and the search card's
// `<span class="price">2 300</span>` (no currency suffix in the span).
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
// domiporta.js / tabelaofert.js / ofertyNet.js stripTags.
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

// Canonicalize a media/cache/<variant>/property/<hash>.jpg URL by stripping
// the variant prefix so multiple references (list, list2x, cart, cart2x,
// cart_zoom) collapse to one canonical URL when deduping. Returns null for
// non-property image URLs (agent-avatar, logo, etc.).
//
//   https://www.okolica.pl/media/cache/list/property/2026/08/<hash>.jpg    → /property/2026/08/<hash>.jpg
//   https://www.okolica.pl/media/cache/cart2x/property/2026/08/<hash>.jpg  → /property/2026/08/<hash>.jpg
//   https://www.okolica.pl/media/cache/cart_zoom/property/2026/08/<hash>.jpg→ /property/2026/08/<hash>.jpg
//   https://www.okolica.pl/media/cache/avatar/avatar/<hash>.jpeg          → null (filtered)
function canonicalPhotoPath(url) {
  if (!url) return null;
  const m = String(url).match(/^(https:\/\/(?:www\.)?okolica\.pl\/media\/cache\/)[a-z0-9_]+(\/property\/[^?#]+)$/i);
  if (m) return m[1].replace('www.', '') + 'cart2x' + m[2];
  return null;
}

// Pick the best variant of an okolica.pl photo URL from a list of variants.
// Variant size rank (largest is best): cart_zoom > cart2x > cart > list2x > list.
// Returns the best URL (or null if the list is empty / no okolica.pl URL).
const SIZE_RANK = { list: 1, list2x: 2, cart: 3, cart2x: 4, cart_zoom: 5 };
function pickBestPhotoVariant(urls) {
  const variants = new Map();
  for (const u of urls) {
    const m = String(u).match(/\/media\/cache\/([a-z0-9_]+)\/property\//i);
    if (!m) continue;
    const variant = m[1];
    const rank = SIZE_RANK[variant] || 0;
    if (rank === 0) continue;
    if (!variants.has(variant) || rank > variants.get(variant).rank) {
      variants.set(variant, { url: u, rank });
    }
  }
  if (!variants.size) return null;
  // Pick the highest-ranked variant available.
  let best = null;
  for (const v of variants.values()) {
    if (!best || v.rank > best.rank) best = v;
  }
  return best ? best.url : null;
}

// "23 min temu" / "5 dni temu" / "wczoraj" → ISO string. The search card's
// `<span class="added_1">23 min temu</span>` is relative — we parse it as a
// best-effort fallback when the detail-page JSON-LD datePosted isn't yet
// available. Mirrors adresowo.js's parsePostedAtFromText approach.
function parseRelativePostedAt(text) {
  if (!text) return null;
  const t = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const now = Date.now();
  const MIN = 60 * 1000;
  const HR = 60 * MIN;
  const DAY = 24 * HR;
  // "23 min temu"
  let m = t.match(/(\d+)\s*min/);
  if (m) return new Date(now - parseInt(m[1], 10) * MIN).toISOString();
  // "5 godz temu" / "5 godzin temu" / "5 godziny temu"
  m = t.match(/(\d+)\s*(godz|godzin)/);
  if (m) return new Date(now - parseInt(m[1], 10) * HR).toISOString();
  // "wczoraj" / "wczoraj o 14:30"
  if (/wczoraj/.test(t)) return new Date(now - DAY).toISOString();
  // "2 dni temu" / "10 dni temu"
  m = t.match(/(\d+)\s*dn/);
  if (m) return new Date(now - parseInt(m[1], 10) * DAY).toISOString();
  // "dziś" / "dzisiaj" — list was added today, postedAt = today's start
  if (/dzis|dzisiaj/.test(t)) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  }
  return null;
}

export class OkolicaScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as domiporta/ofertyNet/
  // nieruchomosciOnline/tabelaofert. The detail-page enrichment (full
  // description / cart2x photos / direct marker) needs to run AFTER the
  // search walk, and the streaming `onListing` path skips enrichment. We
  // retain the listings array (~6 MB for ~1 200 listings × 5 KB payload)
  // and then run the 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'okolica',
      baseUrl: 'https://www.okolica.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const cp = CITY_PATH[city.slug];
    if (!cp) return [];
    const { filters = {}, onListing = null } = options;

    // ---- 1. One-shot fetch of the markers/search API to build a
    // {externalId → {lat, lng}} lookup for the entire city. ----
    // The endpoint returns all map markers within the city bounds (~1 742
    // entries for Warszawa in a 79 KB JSON response). One fetch, no pagination.
    const markers = await this._fetchMarkers(city, cp.query);

    // ---- 2. Walk the paginated search HTML for per-card data. ----
    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('OKOLICA_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // Price filter — okolica.pl exposes cena_od/cena_do query params in its
      // sidebar; we forward the runner-level filters through.
      if (filters.maxPrice != null) params.set('browser[cena_do]', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('browser[cena_od]', String(filters.minPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkanie/wynajme/${cp.path}/${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[okolica] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[okolica] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0;

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[okolica] ${city.slug}: no cards on page 1`);
        else console.log(`[okolica] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      let dupCount = 0;
      let merged = 0;
      for (const card of cards) {
        seen++;
        if (seenExternalIds.has(card.externalId)) {
          dupCount++;
          continue;
        }
        seenExternalIds.add(card.externalId);
        // Merge markers' lat/lng into the card — they're the authoritative
        // coords for the listing (the detail page repeats them as data-lat/
        // data-lng on the map div, but the markers/search API returns them
        // for the whole city in one shot).
        const mk = markers.get(card.externalId);
        if (mk) {
          card.lat = mk.lat;
          card.lng = mk.lng;
          merged++;
        }
        if (onListing) await onListing(card);
        else ads.push(card);
      }
      console.log(
        `[okolica] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, coords merged: ${merged}, total ${seen})`
      );

      // Short page early-stop: pages 1..N have 40 cards each; the true last
      // page returns <OFFERS_PER_PAGE. Use HALF (=20) as the threshold so a
      // natural ±2-card fluctuation doesn't trigger a false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[okolica] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // ---- Markers/search API ----
  //
  // The endpoint returns ALL map markers within the city bounds as a compact
  // JSON array: `{"bounds":[...], "markers":[[lat, lng, externalId, "W/1", 2], ...]}`.
  // One fetch per fetchCity() call. We build a {externalId → {lat, lng}} Map
  // the search-walk merges into each card by externalId.
  //
  // The endpoint accepts browser[*] query params (URL-encoded `[`/`]`):
  //   - browser[sort]=mod_desc       (newest first)
  //   - browser[transaction]=W       (wynajem)
  //   - browser[property]=mieszkanie (apartments)
  //   - browser[query]="Warszawa, Mazowieckie" (the city + voivodeship)
  //   - browser[mode]=api            (force JSON over HTML)
  //   - browser[noagency]=1          (include direct-from-owner)
  //   - browser[agency]=1            (include agency listings)
  //   - browser[aktualnosc]=         (no recency filter — return all)
  //   - browser[distance]=           (no distance-from-center filter)
  async _fetchMarkers(city, query) {
    const params = new URLSearchParams();
    params.set('browser[sort]', 'mod_desc');
    params.set('browser[transaction]', 'W');
    params.set('browser[property]', 'mieszkanie');
    params.set('browser[query]', query);
    params.set('browser[mode]', 'api');
    params.set('browser[noagency]', '1');
    params.set('browser[agency]', '1');
    params.set('browser[aktualnosc]', '');
    params.set('browser[distance]', '');
    const url = `${this.baseUrl}/markers/search/?${params.toString()}`;
    const out = new Map();
    let text;
    try {
      text = await this._fetch(url, { desktop: true, timeout: 20000 });
    } catch (e) {
      console.warn(`[okolica] ${city.slug}: markers/search fetch failed (${e.message}) — proceeding without coords, will use detail-page data-lat/data-lng fallback`);
      return out;
    }
    let data;
    try { data = JSON.parse(text); }
    catch {
      console.warn(`[okolica] ${city.slug}: markers/search response not JSON — proceeding without coords`);
      return out;
    }
    const arr = Array.isArray(data?.markers) ? data.markers : [];
    for (const m of arr) {
      if (!Array.isArray(m) || m.length < 3) continue;
      const lat = parseFloat(m[0]);
      const lng = parseFloat(m[1]);
      const externalId = String(m[2]);
      if (!externalId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Sanity gate: Polish lat range 49-55, lng 14-24. Filters out
      // accidentally-included markers from neighboring cities when the
      // user-supplied query has multiple matches.
      if (lat < 49 || lat > 55 || lng < 14 || lng > 24) continue;
      out.set(externalId, { lat, lng });
    }
    console.log(`[okolica] ${city.slug}: markers/search returned ${out.size} coords`);
    return out;
  }

  // ---- Search-card HTML parser ----
  //
  // Extracts from each `<section class="property" data-id="<external_id>">`:
  //   - externalId: section's data-id (e.g. "34912-W-39468_4034_OMW")
  //   - url: section's <a href="https://www.okolica.pl/offer/show/<external_id>/formular">
  //   - title: <h2 class="property-title"><a>text</a></h2>
  //   - address: <a class="property-address">text</a> — "Warszawa, Powiśle, Solec"
  //   - district: parsed from the address (middle segment after the city)
  //   - price: <li><span class="price">2 300</span> zł</li>
  //   - rooms: <li>Pokoje: 1</li>
  //   - area: <li><span>36</span> m²</li>
  //   - floor: <li>Piętro: 7</li>
  //   - postedAt (rough): <span class="added_1">23 min temu</span>
  //   - images: <img src=".../media/cache/list/property/..." srcset=".../list2x/property/...">
  //     ~9 unique photos per card (varies 1-15; meets the 8-12 target on most
  //     listings). Detail-page enrichment upgrades to cart2x (same photos,
  //     higher resolution) when it runs.
  _parseSearchCards(html, city) {
    const out = [];
    const s = String(html);
    // Match each <section class="property" ...>...</section> block. The cards
    // are top-level siblings in #search-results; the lazy-match captures the
    // full block including the property-actions ul at the end.
    const cardRe = /<section class="property"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi;
    let m;
    while ((m = cardRe.exec(s)) !== null) {
      const externalId = m[1];
      const inner = m[2];
      const card = this._normalizeSearchCard(externalId, inner, city);
      if (card) out.push(card);
    }
    return out;
  }

  _normalizeSearchCard(externalId, inner, city) {
    if (!externalId) return null;

    // Detail URL — extract from the first <a href="https://www.okolica.pl/offer/show/<id>/formular">
    const urlM = inner.match(/href="(https:\/\/(?:www\.)?okolica\.pl\/offer\/show\/[^"?]+\/formular)"/i);
    const url = urlM ? this._normalizeUrl(urlM[1]) : `${this.baseUrl}/offer/show/${externalId}/formular`;

    // Title — <h2 class="property-title"><a href="...">TITLE</a></h2>
    let title = null;
    const titleM = inner.match(/<h2 class="property-title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    if (titleM) title = stripTags(titleM[1]);

    // Address — <a class="property-address" href="...">Warszawa, Powiśle, Solec</a>
    // → split into [city, district, street]. The middle segment is the
    // district (Mokotów, Wola, Powiśle, …); the last segment is the street
    // or sub-area. We use district = middle segment, street = last segment
    // (when present).
    let district = null, street = null, address = null;
    const addrM = inner.match(/<a class="property-address"[^>]*>([\s\S]*?)<\/a>/i);
    if (addrM) {
      address = stripTags(addrM[1]);
      const parts = address.split(',').map(p => p.trim()).filter(Boolean);
      // parts[0] is the city ("Warszawa"). parts[1] is the district
      // ("Powiśle"). parts[2..] is the street/sub-area.
      if (parts.length >= 2) {
        district = parts.slice(1).join(', ');
        if (parts.length >= 3) street = parts[parts.length - 1];
      } else if (parts.length === 1) {
        district = parts[0];
      }
    }

    // Price — <li><span class="price">2 300</span> zł</li>
    let price = null;
    const priceM = inner.match(/<span class="price">([\d\s\u00a0,]+)<\/span>/i);
    if (priceM) {
      const p = parseNum(priceM[1]);
      if (p && p > 0) price = Math.round(p);
    }

    // Rooms — <li>Pokoje: 1</li> or <li>Pokoje: brak</li>
    let rooms = null;
    const roomsM = inner.match(/Pokoje:\s*(\d+)/i);
    if (roomsM) rooms = parseInt(roomsM[1], 10);

    // Area — <li><span>36</span> m<sup>2</sup></li>
    let area = null;
    const areaM = inner.match(/<span>([\d\s\u00a9,]+)<\/span>\s*m<sup>2<\/sup>/i);
    if (areaM) {
      const a = parseNum(areaM[1]);
      if (a && a > 0) area = a;
    }

    // Floor — <li>Piętro: 7</li> (parter → "0"; sometimes "n/parcel")
    let floor = null;
    const floorM = inner.match(/Pi\u0119tro:\s*([^<]+)/i);
    if (floorM) {
      const f = floorM[1].trim();
      if (f) floor = f;
    }

    // Photos — collect all <img src=".../media/cache/<variant>/property/...jpg" srcset=".../list2x/...jpg 2x">
    // variants. We dedupe by the canonical /property/<hash>.jpg path, picking
    // the highest-resolution variant available per photo (cart2x > list2x >
    // cart > list). The search card uses `list` + `list2x`; we keep `list2x`
    // (the larger) when present. Detail-page enrichment upgrades to `cart2x`.
    const variantsByPhoto = new Map();
    const imgRe = /https:\/\/(?:www\.)?okolica\.pl\/media\/cache\/[a-z0-9_]+\/property\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
    let im;
    while ((im = imgRe.exec(inner)) !== null) {
      const variantMatch = im[0].match(/\/media\/cache\/([a-z0-9_]+)\/property\//i);
      const variant = variantMatch ? variantMatch[1] : 'list';
      // Extract the canonical photo path (the /property/<hash>.jpg part)
      const canonM = im[0].match(/(\/property\/[^?#]+\.(?:jpg|jpeg|png|webp))/i);
      if (!canonM) continue;
      const canon = canonM[1];
      if (!variantsByPhoto.has(canon)) variantsByPhoto.set(canon, []);
      variantsByPhoto.get(canon).push(im[0]);
    }
    const images = [];
    for (const variants of variantsByPhoto.values()) {
      const best = pickBestPhotoVariant(variants);
      if (best) images.push(best);
      if (images.length >= 20) break;
    }

    // postedAt — <span class="added_1">23 min temu</span>. Relative time;
    // we parse it as a best-effort fallback (the detail-page JSON-LD
    // datePosted is the authoritative source — _enrichNew overwrites it).
    let postedAt = null;
    const addedM = inner.match(/<span class="added_1">([^<]+)<\/span>/i);
    if (addedM) postedAt = parseRelativePostedAt(addedM[1]);

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: title || `Mieszkanie na wynajem — ${district || city.name_pl}`,
      description: '', // populated from <div class="desc"> in _applyDetail
      price,
      currency: 'PLN',
      rooms,
      area,
      floor,
      district: district || city.name_pl,
      street,
      address: address || [street, district].filter(Boolean).join(', ') || city.name_pl,
      lat: null, // merged from markers/search API in fetchCity()
      lng: null,
      url,
      postedAt,
      images,
      conveniences: [],
      raw: { url, searchCard: { address, price, rooms, area, floor } }
    };
  }

  // ---- Detail-page enrichment (4-worker Promise pool) ----
  //
  // For each NEW listing (or known one with < 3 photos), fetch the detail
  // page and extract:
  //   - Full Polish description from <div class="desc">
  //   - postedAt from JSON-LD RealEstateListing.datePosted ("2026-08-29")
  //   - cart2x photo URLs (upgrade from the search card's list2x — same
  //     photos, higher resolution)
  //   - lat/lng from <div id="map" data-lat data-lng> (fallback when the
  //     markers/search API didn't have the entry — defensive, should be rare)
  //   - direct-from-owner marker from <div class="ownerType"> (text ==
  //     "Bezpośrednio" → convenience)
  //   - title from <h1> (more authoritative than search card's <h2>)
  //   - price/rooms/area/floor from <ul class="property-data"><li>...
  //     (verifies / backfills the search card's values)
  async _enrichNew(ads) {
    if (!ads.length) return;
    // Build the set of listings that already have full data in the DB
    // (>=3 photos AND non-null coords). These are skipped — no point
    // re-fetching their detail page when we already have everything we
    // need. Listings with <3 photos OR null coords are re-enriched so
    // the detail page's <div class="desc"> / cart_zoom photos / data-lat
    // data-lng fallback can fill in the gaps.
    let knownComplete = new Set();
    try {
      const rows = await many(
        `SELECT l.external_id FROM listings l
         WHERE l.source_id = $1 AND l.external_id = ANY($2::text[])
           AND (SELECT count(*) FROM listing_images li WHERE li.listing_id = l.id) >= 3
           AND l.lat IS NOT NULL AND l.lng IS NOT NULL`,
        [SOURCE_ID, ads.map(a => a.externalId)]
      );
      knownComplete = new Set(rows.map(r => r.external_id));
    } catch {}
    // Enrich any listing that is new OR missing data (photos/coords).
    // Re-enriching the latter is essential for the quality bar
    // (lat/lng MUST not be null) — the markers/search API returns coords
    // for ~86% of Warsaw listings; the remaining ~14% need a detail-page
    // fetch to recover coords from <div id="map" data-lat data-lng>.
    const fresh = ads
      .filter(a => !knownComplete.has(a.externalId))
      .slice(0, ENRICH_LIMIT);
    if (!fresh.length) return;
    console.log(`[okolica] enriching ${fresh.length} listings (desc/photos/coords)`);

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
          console.warn(`[okolica] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as
        // gratka/ofertyNet/domiporta/tabelaofert.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Fetches:
  //   - JSON-LD RealEstateListing block (name, description, datePosted,
  //     offers.price, identifier)
  //   - <h1>title</h1> (verifies / overwrites the search card's title)
  //   - <ul class="property-data"><li>Cena za miesiąc|Powierzchnia|Liczba
  //     pokoi|Piętro:...</li></ul> (verifies / backfills search-card values)
  //   - <div id="map" data-lat data-lng> (coords — fallback when markers
  //     didn't return for the listing)
  //   - <div class="desc">…full Polish text with <br />…</div>
  //   - <div class="ownerType">Bezpośrednio|Agencja|...</div> (direct marker)
  //   - <img src=".../media/cache/cart2x/property/..."> (gallery — upgrades
  //     from list2x to cart2x, larger resolution)
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD RealEstateListing block ----
    const blocks = this._extractJsonLd(s);
    let listingBlock = null;
    for (const b of blocks) {
      if (b && b['@type'] === 'RealEstateListing') { listingBlock = b; break; }
    }
    if (listingBlock) {
      // Name (full title — JSON-LD `name` is the un-truncated full title)
      if (listingBlock.name) {
        const t = String(listingBlock.name).trim();
        if (t) ad.title = t;
      }

      // Description — JSON-LD `description` is TRUNCATED at ~303 chars. We
      // still keep it as a fallback in case the <div class="desc"> parse
      // fails (the div has the full Polish text).
      if (listingBlock.description) {
        const d = stripTags(String(listingBlock.description));
        if (d && d.length > (ad.description || '').length) ad.description = d;
      }

      // postedAt — JSON-LD datePosted is an ISO date ("2026-08-29").
      if (listingBlock.datePosted) {
        const dp = String(listingBlock.datePosted);
        const iso = /^(\d{4})-(\d{2})-(\d{2})$/.test(dp)
          ? `${dp}T00:00:00Z`
          : dp;
        const d = new Date(iso);
        if (!isNaN(d.getTime())) ad.postedAt = d.toISOString();
      }

      // Price — JSON-LD offers.price ("2300.00"). Verifies / backfills the
      // search card's price (sometimes the search card misses decimals).
      if (Array.isArray(listingBlock.offers) ? listingBlock.offers[0] : listingBlock.offers) {
        const off = Array.isArray(listingBlock.offers) ? listingBlock.offers[0] : listingBlock.offers;
        if (off && off.price != null) {
          const p = parseNum(off.price);
          if (p && p > 0) ad.price = Math.round(p);
        }
      }

      // identifier (== external_id) — sanity-check the URL match.
      // (not stored separately)
    }

    // ---- 2. <h1>title</h1> — second priority after JSON-LD `name`. ----
    if (!ad.title || ad.title.startsWith('Mieszkanie na wynajem —')) {
      const h1M = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1M) {
        const t = stripTags(h1M[1]);
        if (t) ad.title = t;
      }
    }

    // ---- 3. <ul class="property-data"><li>...</li></ul> ----
    // Each <li> has <span>Label:</span> <span>value [unit]</span>. Parse the
    // four core fields when missing from the search card.
    const dataM = s.match(/<ul class="property-data"[^>]*>([\s\S]*?)<\/ul>/i);
    if (dataM) {
      const dataBlock = dataM[1];
      // Each <li>...</li> wraps a label+value pair.
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRe.exec(dataBlock)) !== null) {
        const liInner = li[1];
        // Extract label text (strip tags)
        const label = stripTags(liInner).toLowerCase();
        if (/cena za miesi/.test(label) && !ad.price) {
          const pM = liInner.match(/<span class="price">([\d\s\u00a0,]+)<\/span>/i);
          if (pM) {
            const p = parseNum(pM[1]);
            if (p && p > 0) ad.price = Math.round(p);
          }
        }
        if (/powierzchnia/.test(label) && !ad.area) {
          const aM = liInner.match(/<span[^>]*>([\d\s\u00a0,]+)<\/span>\s*m<sup>2<\/sup>/i);
          if (aM) {
            const a = parseNum(aM[1]);
            if (a && a > 0) ad.area = a;
          }
        }
        if (/liczba pokoi/.test(label) && !ad.rooms) {
          const rM = liInner.match(/<span[^>]*>(\d+)<\/span>/i);
          if (rM) ad.rooms = parseInt(rM[1], 10);
        }
        if (/pi\u0119tro/.test(label) && !ad.floor) {
          // <span>7</span> or just "7"
          const fM = liInner.match(/<span[^>]*>([^<]+)<\/span>\s*$/i);
          if (fM) ad.floor = fM[1].trim();
        }
      }
    }

    // ---- 4. <div id="map" data-lat data-lng> — coords fallback ----
    // Only set when markers/search API didn't have the entry (defensive —
    // the markers endpoint returns coords for the whole city in one shot).
    if (ad.lat == null || ad.lng == null) {
      const mapM = s.match(/<div[^>]*id="map"[^>]*data-lat="([\d.]+)"[^>]*data-lng="([\d.]+)"/i);
      if (mapM) {
        const lat = parseFloat(mapM[1]);
        const lng = parseFloat(mapM[2]);
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            lat > 49 && lat < 55 && lng > 14 && lng < 24) {
          ad.lat = lat;
          ad.lng = lng;
        }
      }
    }

    // ---- 5. Full Polish description from <div class="desc"> ----
    // The div contains the entire agent-written text with <br /> line breaks.
    // The JSON-LD `description` is a 303-char truncation; this div has the
    // full 700-3000 char text. We overwrite only if longer (defensive).
    const descM = s.match(/<div class="desc">([\s\S]*?)<\/div>\s*(?:<div class="nr"|$)/i);
    if (descM) {
      const d = stripTags(descM[1]);
      if (d && d.length > (ad.description || '').length) ad.description = d;
    } else {
      // Fallback: greedy close on the next sibling div.
      const altM = s.match(/<div class="desc">([\s\S]*?)<\/div>\s*<div/i);
      if (altM) {
        const d = stripTags(altM[1]);
        if (d && d.length > (ad.description || '').length) ad.description = d;
      }
    }

    // ---- 6. Direct-from-owner marker from <div class="ownerType"> ----
    // The div's text is "Bezpośrednio" for direct-from-owner listings,
    // "Agencja" for agency listings. We push a "direct" convenience so the
    // UI can surface it like adresowo/tabelaofert's direct marker.
    const ownerM = s.match(/<div class="ownerType"[^>]*>\s*([^<]+?)\s*<\/div>/i);
    if (ownerM) {
      const ownerType = stripTags(ownerM[1]);
      if (/bezpo[sś]rednio/i.test(ownerType)) {
        if (!ad.conveniences) ad.conveniences = [];
        if (!ad.conveniences.some(c => c.type === 'direct')) {
          ad.conveniences.push({ type: 'direct', label: 'Bez pośredników' });
        }
      }
    }

    // ---- 7. Photo gallery upgrade — cart_zoom > cart2x > cart > list2x ----
    // The detail page's <img src=".../media/cache/cart/property/..." srcset=
    // ".../media/cache/cart2x/property/..."> + og:image meta tag uses the
    // same set of photo hashes as the search card, just at higher
    // resolution. cart_zoom (the largest variant, used in the og:image meta
    // tag + carousel) is available for every photo on the detail page, so
    // we rank it highest and pick it when present. Falls back to cart2x,
    // cart, list2x in that order. We dedupe by the canonical
    // /property/<hash>.jpg path and overwrite the search card's images
    // list (which used list2x — smaller resolution than cart_zoom).
    const variantsByPhoto = new Map();
    const imgRe = /https:\/\/(?:www\.)?okolica\.pl\/media\/cache\/[a-z0-9_]+\/property\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
    let im;
    while ((im = imgRe.exec(s)) !== null) {
      const canonM = im[0].match(/(\/property\/[^?#]+\.(?:jpg|jpeg|png|webp))/i);
      if (!canonM) continue;
      const canon = canonM[1];
      if (!variantsByPhoto.has(canon)) variantsByPhoto.set(canon, []);
      variantsByPhoto.get(canon).push(im[0]);
    }
    const images = [];
    for (const variants of variantsByPhoto.values()) {
      const best = pickBestPhotoVariant(variants);
      if (best) images.push(best);
      if (images.length >= 20) break;
    }
    if (images.length) ad.images = images;
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Okolica's listing URLs are clean by default, but
  // normalizing defensively protects against future regressions and against
  // imported URLs with utm_*/fbclid etc. Mirrors D1/D2/D3/D5.
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
