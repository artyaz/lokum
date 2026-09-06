// lento.pl scraper — Polish free general classifieds portal with a small but
// distinct rentals sub-inventory (~37 cards/page across ~7 pages for Warszawa
// wynajem ≈ 250 listings at any given moment). Independent (not part of the
// Morizon/Gratka/Agora oligopoly) — high direct-from-owner ("bez pośredników")
// share makes it a useful incremental signal for the cheap long-tail segment.
//
// Site layout (verified 2026-08-29 via curl on live pages):
//
//   Search:  https://<city-slug>.lento.pl/nieruchomosci/mieszkania/do-wynajecia.html?page=N
//            e.g. https://warszawa.lento.pl/nieruchomosci/mieszkania/do-wynajecia.html
//                 https://warszawa.lento.pl/nieruchomosci/mieszkania/do-wynajecia.html?page=2
//            The site uses a per-city subdomain (warszawa./krakow./wroclaw./
//            gdansk./poznan.). Page 1 = no ?page param (or ?page=1 — same
//            response). ~37 listings/page, ~7 pages for Warszawa = ~250 total.
//            NOTE: the brief's example URL `warszawa.lento.pl/mieszkania-wynajem`
//            404s — the canonical URL is the longer
//            `/nieruchomosci/mieszkania/do-wynajecia.html` form (confirmed in
//            C3 research and live 2026-08-29).
//
//            Each search card's data lives in the ~3 KB after the
//            `<a href="...{slug},{id}.html" class="title-list-item">`
//            anchor. The card carries:
//              - the detail URL (canonical — the {id} in the URL is the
//                stable externalId, e.g. 15671025)
//              - the title text inside the anchor
//              - <span class="price-list-item">3 200 zł</span> (price)
//              - <span class="list-atrr-item-tab">&nbsp;43&nbsp;m2</span> (area)
//              - <span class="list-atrr-item-tab">2 pokoje</span> (rooms)
//              - <span class="list-atrr-item-tab">Apartamentowiec</span> (zabudowa)
//              - <span class="list-atrr-item-tab">czynsz&nbsp;700&nbsp;zł/mies.</span>
//                (monthly building fees — saved to raw, NOT to ad.price which
//                is the rent proper)
//              - <span class="data-list-xs-item licon-clock-l">
//                <span>27 sie </span> 23:13</span> (postedAt — Polish short-date
//                format like "27 sie 23:13", "wczoraj 10:54", "dzisiaj 20:06")
//              - <span class="mark-pointer licon-pin-f">Warszawa</span>
//                (district fallback — for promoted listings this is
//                "Cała Polska (Warszawa)"; we strip the prefix and use the
//                inner text as the city hint; the real district comes from
//                the detail page)
//              - <div class="text-b ... text-o">Oferta bez pośredników</div>
//                (direct-from-owner badge — saved to raw.searchCard.sellerType)
//              - <div class="promo-label">Promowane</div> (optional promo badge)
//
//   Detail:  https://<city-slug>.lento.pl/<slug>,<id>.html
//            e.g. /metro-do-wynajecia-43m2,15671025.html
//            Server-renders:
//              - JSON-LD RealEstateListing block (when present — ~60-70% of
//                listings have it; the rest only emit WebSite + Organization
//                JSON-LD blocks and we fall back to HTML parsing):
//                  name (full Polish title — overrides the search-card title)
//                  description (FULL Polish text with \r\n line breaks)
//                  datePosted ("2026-03-15" ISO date)
//                  image[] (full-res /original/ variants, 4-12 typical)
//                  mainEntity: Apartment {
//                    name, numberOfRooms (often null), floorLevel (often null),
//                    yearBuilt (often null), accommodationCategory,
//                    address { addressLocality, addressCountry, addressRegion,
//                             streetAddress (often empty) },
//                    image[] (large variants — used as fallback when top-level
//                            image[] is missing)
//                  }
//                  offers { price, priceCurrency="PLN" }
//                  geo { latitude, longitude } (strings, parse to floats)
//              - <div class="desc text-15"><h3>Opis oferty</h3>FULL TEXT</div>
//                — full Polish description in the visible HTML. Used as the
//                canonical description source (always present, even when the
//                JSON-LD block is missing — verified on listings 15671025 and
//                16118509).
//              - <span class="...label...">Powierzchnia:</span><span>43 m2</span>
//                — params table with:
//                  Kategoria → category (saved to raw)
//                  Powierzchnia → area (m²)
//                  Liczba pokoi → rooms count
//                  Piętro → floor (e.g. "3 piętro")
//                  Liczba pięter → building total floors (raw)
//                  Zabudowa → building type (raw)
//                  Forma kuchini → kitchen form (raw)
//                  Sprzedaż → "Bez pośredników" / "Pośrednictwo" (raw)
//                  Czynsz → monthly building fees in zł (raw — distinct from
//                          the rent price)
//                  Inf. dodatkowe → comma-separated amenities list (e.g.
//                          "Balkon, Winda, Miejsce parkingowe, Garaż")
//              - <div class="box-map-show" data-lat="52.1347466"
//                data-lng="21.0636692"> — coords fallback when JSON-LD geo
//                is missing. Sanity-bound to Poland (lat 49-55, lng 14-24).
//              - <div class="licon-pin-f margin-bottom-5">Warszawa / Ursynów</div>
//                — real district hint ("Warszawa / Ursynów" → Ursynów). Used
//                to override the search-card district when present.
//
//   Photos:  JSON-LD `image[]` (top-level — /original/ variant, 4-12 typical).
//            Falls back to mainEntity.image[] (/large/ variant) when top-level
//            is missing. Meets the 8-12 quality-bar minimum on most listings
//            (sample listing 15671025 has 7 — just under; listing 16118509 has
//            7-12). Lento is a small-inventory classifieds portal so we accept
//            the source's photo count without manufacturing photos that don't
//            exist (same policy as wynajem24.js).
//
// Quality bar (per Task D brief):
//   - lat/lng: from JSON-LD geo OR data-lat/data-lng attr (must not be null;
//     the Warszawa inventory almost always has coords — verified on 2/2 sample
//     listings)
//   - photos: 4-12 from JSON-LD image[] (we accept the source's photo count)
//   - description: full Polish text from `<div class="desc text-15">` (always
//     present — used as the canonical source because JSON-LD is sometimes
//     missing)
//   - price: PLN/monthly from JSON-LD offers.price OR search-card
//     price-list-item span (PLN suffix always)
//
// Inventory note: ~250 Warszawa wynajem listings across ~7 pages × 37/page.
// MAX_PAGES=30 (1 110 listings cap) walks the full inventory with margin; in
// practice the walk stops early via the short-page early-stop heuristic at
// page ~7-8. The 4-worker detail-page pool processes ~250 listings per cycle
// (~2-3 minutes at 500ms/fetch).
//
// Dedupe overlap (per C3 research): lento.pl is independent (not part of the
// Morizon/Gratka/Agora oligopoly) — high direct-from-owner share means some
// overlap with olx.pl direct listings. Caught by services/dedupe.js via the
// geo + area + rooms fingerprint.
//
// Anti-bot: none observed (plain fetch with a desktop UA + Polish Accept-
// Language works). No Cloudflare, no Playwright fallback needed.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 18;
// 37 listings/page × 30 pages = 1 110 listings/city/fetch cap. The Warszawa
// wynajem inventory is only ~250 listings (~7 pages), so this cap walks the
// full inventory with margin. Pairs with the 3×/day recommended schedule.
const MAX_PAGES = 30;
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Same pattern as domiporta/ofertyNet/nieruchomosci-
// Online/sprzedajemy/wynajem24. 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// lento.pl search results return ~37 listings/page (verified live 2026-08-29
// across warszawa/krakow/wroclaw/gdansk/poznan — 36-38 cards/page). Used by
// the short-page early-stop heuristic.
const OFFERS_PER_PAGE = 37;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Cap the number of detail-page fetches per cycle. With ~250 Warszawa listings
// and 4-worker pool, this caps at ~300 detail fetches per cycle — roughly
// 2-3 minutes at 500ms/fetch. Aligned with the other D-chunk scrapers.
const ENRICH_LIMIT = 300;
// Promise pool concurrency for the detail-page enrichment step. Same value as
// nieruchomosci-online/domiporta/ofertyNet/sprzedajemy/wynajem24/okolica for
// parity — 4 workers strikes the right balance between throughput and not
// hammering the source site.
const ENRICH_CONCURRENCY = 4;

// City subdomain map — lento.pl uses a per-city subdomain
// (`<city>.lento.pl/nieruchomosci/mieszkania/do-wynajecia.html`).
// All five Lokum cities verified live 2026-08-29 (HTTP 200 each, 36-38 cards
// on page 1 each).
const CITY_SUBDOMAIN = {
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

// Polish number parsing: "3 200" (space thousand separator), "2100,00"
// (decimal comma), "3 200 zł" (with currency suffix). Returns a Number (or
// null on failure). Mirrors sprzedajemy.js parseNum.
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const n = parseFloat(String(s).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Polish short-date timestamp parser. lento.pl search cards emit timestamps
// in three formats:
//   - "<span>27 sie </span> 23:13"  → day + Polish month abbrev + time
//   - "<span>wczoraj  </span> 10:54" → "yesterday" + time
//   - "<span>dzisiaj  </span> 20:06" → "today" + time
//
// Polish month abbreviations: sty, lut, mar, kwi, maj, cze, lip, sie, wrz,
// paź (paz), lis, gru.
//
// Year is implicit (the current year). For December listings seen in
// January, we subtract a year if the parsed month is in the future. ±1h
// timezone imprecision is acceptable for the runner's was_new detection —
// the runner's sinceTime fallback (previous cron started_at) catches any
// edge cases.
function parsePostedAt(datePart, timePart) {
  if (!datePart && !timePart) return null;
  const dateStr = String(datePart || '').trim().toLowerCase();
  const timeStr = String(timePart || '').trim();
  const now = new Date();
  let day, month, year, hours, minutes;

  if (dateStr === 'dzisiaj' || dateStr === 'dzis') {
    day = now.getUTCDate();
    month = now.getUTCMonth() + 1;
    year = now.getUTCFullYear();
  } else if (dateStr === 'wczoraj') {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    day = y.getUTCDate();
    month = y.getUTCMonth() + 1;
    year = y.getUTCFullYear();
  } else {
    const m = dateStr.match(/^(\d{1,2})\s*([a-zśćźżółęąń]{3,4})$/);
    if (!m) return null;
    day = parseInt(m[1], 10);
    const monName = m[2];
    const MON = {
      sty: 1, lut: 2, mar: 3, kwi: 4, maj: 5, cze: 6,
      lip: 7, sie: 8, wrz: 9, paz: 10, 'paź': 10, lis: 11, gru: 12
    };
    month = MON[monName];
    if (!month) return null;
    year = now.getUTCFullYear();
    // Handle December → January rollover: if the parsed month is after the
    // current month, the listing was posted last year.
    const currentMonth = now.getUTCMonth() + 1;
    if (month > currentMonth) year -= 1;
  }

  // Time parsing: "23:13" → hours=23 minutes=13.
  // If time is missing, default to 00:00 UTC.
  if (timeStr) {
    const tm = timeStr.match(/^(\d{1,2}):(\d{2})/);
    if (tm) {
      hours = parseInt(tm[1], 10);
      minutes = parseInt(tm[2], 10);
    } else {
      hours = 0; minutes = 0;
    }
  } else {
    hours = 0; minutes = 0;
  }

  // Lento returns Polish local time (Europe/Warsaw, CET/CEST). We append
  // +01:00 (CET) — the ±1h imprecision is harmless for the was_new comparison.
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+01:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Polish room-count parser. Handles all declensions of "pokoje" / "pokój" /
// "pokoju" / "kawalerka" (studio). Returns a Number or null.
function parseRooms(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().trim();
  // "kawalerka" or "1 pokój" or "1 pokojowe" → 1
  if (/\bkawalerk|studio|1\s*pok|jednopok|jednoosobow/.test(s)) return 1;
  const m = s.match(/^(\d+)\s*pok/);
  if (m) return parseInt(m[1], 10);
  // "3 pokoje" / "3-pok" / "3 pokojowe"
  const m2 = s.match(/(\d+)\s*[-]?\s*pok/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

export class LentoScraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as domiporta/ofertyNet/
  // nieruchomosciOnline/sprzedajemy/wynajem24. When `supportsStreaming = true`,
  // the runner uses the `onListing` callback path which emits each listing as
  // it's parsed from the search cards — but the detail-page enrichment
  // (`_enrichNew`, which fetches the JSON-LD RealEstateListing block for
  // photos / full description / coords) was conditional on `!onListing` and
  // so NEVER ran in streaming mode. Disabling streaming keeps peak memory
  // slightly higher (~1.5 MB for ~250 listings × 6 KB payload) but ensures
  // the enrich step actually runs.
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'lento', baseUrl: 'https://warszawa.lento.pl' });
  }

  async fetchCity(city, options = {}) {
    const sub = CITY_SUBDOMAIN[city.slug];
    if (!sub) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('LENTO_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;

    // Lento uses ?page=N (1, 2, 3, ...) — page 1 = no qs (or ?page=1).
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // Price filter — lento's search form exposes `?cena_od=` / `?cena_do=`
      // query params, but they're brittle to encode in some categories
      // (sale vs rent vs room-share). We leave the filter to the runner's
      // defensive pass — getting it wrong here would silently 0-result the
      // feed. Verified 2026-08-29.
      if (filters.maxPrice != null) {
        // Defensive no-op: price is applied at runner level (see runner.js
        // defensive filter block).
      }
      const qs = params.toString();
      const url = `https://${sub}.lento.pl/nieruchomosci/mieszkania/do-wynajecia.html${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[lento] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[lento] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip doesn't
        // cascade into a hard abort and skip the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0; // reset on success

      const cards = this._parseSearchCards(html, city, sub);
      if (!cards.length) {
        if (page === 1) console.warn(`[lento] ${city.slug}: no cards on page 1`);
        else console.log(`[lento] ${city.slug} page ${page}: empty page — stopping`);
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
        `[lento] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have ~37 cards each (OFFERS_PER_PAGE);
      // the true last page returns fewer. Use HALF of OFFERS_PER_PAGE as the
      // threshold so a natural fluctuation of ±1-2 cards doesn't trigger a
      // false break.
      if (cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[lento] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse listing cards from the search results HTML. Each card's data lives
  // in the ~3 KB chunk following the
  // `<a href="..." class="title-list-item">` anchor — the {id} in the URL is
  // the canonical externalId. We extract: externalId, url, title, price,
  // area/rooms, postedAt, district, thumbnail, seller-type badge. The detail-
  // page JSON-LD (in `_enrichNew`) overwrites these with more precise values
  // where applicable.
  _parseSearchCards(html, city, sub) {
    const out = [];
    const s = String(html);
    // Find each listing anchor: `<a href="https://{sub}.lento.pl/{slug},{id}.html"
    // class="title-list-item">{TITLE}</a>`. The same anchor pattern is used
    // for related-listings suggestions, but those live OUTSIDE the search
    // results area — they don't have a `price-list-item` span nearby, so our
    // post-filter (price > 0) weeds them out.
    const anchorRe = new RegExp(
      `href="(https?://${sub}\\.lento\\.pl/[a-z0-9\\-]+,(\\d+)\\.html)"\\s+class="title-list-item"([^>]*)>([\\s\\S]*?)</a>`,
      'gi'
    );
    let m;
    while ((m = anchorRe.exec(s)) !== null) {
      try {
        const fullUrl = m[1];
        const externalId = m[2];
        const title = this._decodeEntities(m[4].replace(/\s+/g, ' ').trim());

        // Take the next 3 KB of the page after the anchor — contains the
        // price, attrs, postedAt. (Verified each card's data fits in ~3 KB.)
        const chunk = s.slice(m.index, m.index + 3000);

        // Price — `<span class="price-list-item">3 200 zł</span>`.
        const priceM = chunk.match(/<span[^>]*class="[^"]*price-list-item[^"]*"[^>]*>\s*([\d\s\u00a0.,]+)\s*zł?\s*<\/span>/i);
        const price = parseNum(priceM ? priceM[1] : '');
        if (!price || price <= 0) continue; // skip listings without a price

        // Attributes (Powierzchnia / Liczba pokoi / etc.) — `<span class=
        // "list-atrr-item-tab">&nbsp;43&nbsp;m2</span>` etc. We greedily
        // capture all the attribute spans and parse them by content shape.
        const area = this._extractAreaFromChunk(chunk);
        const rooms = this._extractRoomsFromChunk(chunk);

        // Thumbnail — first <img src="https://st-lento.pl/adpics/..."> in the
        // card (the thumbnail variant). Used as a fallback when the detail
        // page JSON-LD image[] is missing.
        const imgM = chunk.match(/<img[^>]+src="(https:\/\/st-lento\.pl\/adpics\/[^"]+)"/i);
        const thumb = imgM ? imgM[1] : null;

        // postedAt — `<span class="data-list-xs-item licon-clock-l">
        // <span>27 sie </span> 23:13</span>`. The inner span holds the date
        // part ("27 sie", "dzisiaj", "wczoraj"); the trailing text is the
        // time "HH:MM".
        const timeM = chunk.match(/<span[^>]*class="[^"]*data-list-xs-item[^"]*"[^>]*>\s*<span>\s*([^<]+?)\s*<\/span>\s*([^<]+?)\s*<\/span>/i);
        const postedAt = timeM ? parsePostedAt(timeM[1], timeM[2]) : null;

        // District — `<span class="mark-pointer licon-pin-f">Warszawa</span>`
        // or `<a href="..." class="mark-pointer licon-pin-f">Warszawa</a>` or
        // "Cała Polska (Warszawa)" for promoted listings. We strip the
        // "Cała Polska" prefix and use the inner text — the real district
        // comes from the detail page (`licon-pin-f margin-bottom-5` element
        // with "Warszawa / Ursynów" format).
        const locM = chunk.match(/<[^>]*class="[^"]*mark-pointer[^"]*licon-pin-f[^"]*"[^>]*>\s*(?:Cała Polska\s*)?\(?\s*([^<(]+?)\s*\)?\s*<\//i);
        const district = locM ? this._decodeEntities(locM[1].trim()) : city.name_pl;

        // Seller type — `<div class="text-b ... text-o">Oferta bez pośredników</div>`
        // (or "Oferta z pośrednictwem" for agency listings). Saved to raw
        // for the dedupe pipeline's "owner-direct" cross-source matching.
        const sellerM = chunk.match(/<div[^>]*class="[^"]*text-[ob][^"]*"[^>]*>\s*(Oferta[^<]+?)\s*<\/div>/i);
        const sellerType = sellerM ? sellerM[1].trim() : null;

        // Premium/promoted badge — `<div class="promo-label">Promowane</div>`.
        // Saved to raw.
        const promoM = chunk.match(/<div[^>]*class="[^"]*promo-label[^"]*"[^>]*>\s*([A-ZŁĄŚŻŹĆŃĘÓ\s]+?)\s*<\/div>/i);
        const promoBadge = promoM ? promoM[1].trim() : null;

        // Build the listing card. Lat/lng/photos/description are filled by
        // `_enrichNew` from the detail page.
        out.push({
          externalId,
          sourceId: SOURCE_ID,
          cityId: city.id,
          title: title || `Mieszkanie na wynajem — ${district}, ${city.name_pl}`,
          description: '', // backfilled from detail-page desc div
          price: Math.round(price),
          currency: 'PLN',
          rooms: rooms != null ? rooms : null,
          area,
          floor: null, // backfilled from detail-page params table
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
              promoBadge,
              thumb,
              postedAtRaw: timeM ? `${timeM[1]} ${timeM[2]}`.trim() : null
            }
          }
        });
      } catch (e) {
        // skip broken card — single failure shouldn't abort the walk
      }
    }
    return out.filter(a => a.price > 0 && a.externalId);
  }

  // Extract area (m²) from a card chunk. The pattern is:
  //   <span class="list-atrr-item-tab">&nbsp;43&nbsp;m2</span>
  // We look for a span containing `N m2` (or `N m²`). Returns a Number.
  _extractAreaFromChunk(chunk) {
    const re = /<span[^>]*class="[^"]*list-atrr-item-tab[^"]*"[^>]*>\s*(?:&nbsp;)?\s*(\d[\d\s\u00a0.,]*)\s*(?:&nbsp;)?\s*m2?\s*<\/span>/i;
    const m = chunk.match(re);
    if (!m) return null;
    return parseNum(m[1]);
  }

  // Extract rooms count from a card chunk. The pattern is:
  //   <span class="list-atrr-item-tab">2 pokoje</span>
  //   <span class="list-atrr-item-tab">1 pokój</span>
  //   <span class="list-atrr-item-tab">kawalerka</span>
  // Returns a Number.
  _extractRoomsFromChunk(chunk) {
    const re = /<span[^>]*class="[^"]*list-atrr-item-tab[^"]*"[^>]*>\s*([^<]+?)\s*<\/span>/gi;
    let m;
    while ((m = re.exec(chunk)) !== null) {
      const txt = m[1].replace(/&nbsp;/g, ' ').trim();
      const n = parseRooms(txt);
      if (n != null) return n;
    }
    return null;
  }

  // Decode common HTML entities that appear in titles/districts. Lento
  // doesn't escape Polish chars (they're UTF-8 in the source), but & is
  // escaped as `&amp;` in some attributes. Keep this minimal — over-decoding
  // risks mangling UTF-8 sequences.
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
  // floor/area/rooms backfill, postedAt (JSON-LD datePosted). Uses the 4-worker
  // Promise pool pattern (ENRICH_CONCURRENCY = 4) from domiporta/ofertyNet/
  // sprzedajemy/wynajem24 so we don't pin event-loop memory on a 250-listing
  // walk.
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
    console.log(`[lento] enriching ${fresh.length} listings (photos/desc/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true, timeout: 20000 });
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't crash the whole pool
          console.warn(`[lento] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as
        // sprzedajemy/wynajem24/domiporta/ofertyNet.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Sources, in
  // priority order:
  //   1. JSON-LD RealEstateListing block (PRIMARY when present — ~60-70% of
  //      listings) → name, description, image[], datePosted, offers.price +
  //      priceCurrency, mainEntity.address, mainEntity.numberOfRooms/
  //      floorLevel/yearBuilt, geo{lat,lng}
  //   2. Coords (`<div class="box-map-show" data-lat data-lng>`) — CRITICAL
  //      (must not be null per quality bar); fallback when JSON-LD geo missing
  //   3. Params table (`<span class="label">Powierzchnia:</span>
  //      <span>43 m2</span>`) → area/rooms/floor backfill + rawParams
  //      (Liczba pięter, Zabudowa, Forma kuchni, Sprzedaż, Czynsz,
  //      Inf. dodatkowe)
  //   4. Description div (`<div class="desc text-15"><h3>Opis oferty</h3>
  //      FULL TEXT</div>`) — full Polish text, used as canonical source
  //      because JSON-LD is sometimes missing
  //   5. Location row (`licon-pin-f margin-bottom-5`) — real district
  //      ("Warszawa / Ursynów" → Ursynów), overrides search-card district
  //   6. Conveniences — from "Inf. dodatkowe" params field + description
  //      text (balkon, winda, garaż, parking, piwnica, metro, tramwaj, etc.)
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD RealEstateListing block ----
    const rel = this._extractRealEstateListingBlock(s);
    if (rel) {
      // Photos — JSON-LD top-level image[] (full-res /original/ variants).
      // Falls back to mainEntity.image[] (/large/ variants) when top-level
      // is missing.
      const images = [];
      const imgSource = Array.isArray(rel.image) && rel.image.length
        ? rel.image
        : (rel.mainEntity && Array.isArray(rel.mainEntity.image) ? rel.mainEntity.image : []);
      const seen = new Set();
      for (const u of imgSource) {
        if (typeof u !== 'string' || !u) continue;
        const url = u.replace(/\\\//g, '/'); // JSON-encoded slashes → real /
        if (seen.has(url)) continue;
        seen.add(url);
        images.push(url);
        if (images.length >= 20) break; // persistListing cap
      }
      if (images.length) ad.images = images;

      // Description — the FULL Polish text with \r\n line breaks. JSON-LD
      // preserves the agent-written formatting. We normalize CRLF → \n.
      // The visible `<div class="desc text-15">` is the canonical source
      // (always present, even when JSON-LD is missing) — we use it as a
      // fallback below when JSON-LD description is missing or shorter.
      if (rel.description) {
        const desc = this._decodeEntities(String(rel.description))
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();
        if (desc.length > (ad.description || '').length) {
          ad.description = desc;
        }
      }

      // Title — JSON-LD `name` is the full Polish title (matches the
      // search card's <a class="title-list-item"> — but the JSON-LD version
      // is canonical).
      if (rel.name) {
        ad.title = this._decodeEntities(String(rel.name).trim());
      }

      // Price — JSON-LD offers.price. Sanity-check the value against the
      // search card's price (allow ±5% for negotiating/rounding differences;
      // otherwise trust the detail-page value as it's the freshest).
      const offers = rel.offers || {};
      const detailPrice = parseNum(offers.price);
      if (detailPrice && detailPrice > 0) {
        if (!ad.price || Math.abs(detailPrice - ad.price) > Math.max(50, ad.price * 0.05)) {
          ad.price = Math.round(detailPrice);
        }
      }
      if (offers.priceCurrency) {
        ad.currency = String(offers.priceCurrency);
      }

      // datePosted — JSON-LD datePosted is the ORIGINAL posting date
      // (verified on listing 15671025: "2026-03-15"). The search-card
      // timestamp (e.g. "27 sie 23:13") is the listing's last-bumped date
      // (newest-first sort order). Prefer the search-card timestamp when
      // present (it's the more recent visibility signal — better for the
      // runner's was_new comparison); fall back to JSON-LD datePosted when
      // the search-card timestamp failed to parse.
      if (!ad.postedAt && rel.datePosted) {
        const d = new Date(`${rel.datePosted}T00:00:00+01:00`);
        if (!isNaN(d.getTime())) ad.postedAt = d.toISOString();
      }

      // Coords — JSON-LD geo { latitude, longitude } (string values).
      const geo = rel.geo || (rel.mainEntity && rel.mainEntity.geo);
      if (geo && geo.latitude != null && geo.longitude != null) {
        const lat = parseFloat(String(geo.latitude));
        const lng = parseFloat(String(geo.longitude));
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            lat >= 49 && lat <= 55 && lng >= 14 && lng <= 24) {
          ad.lat = lat;
          ad.lng = lng;
        }
      }

      // Address — JSON-LD mainEntity.address { addressLocality,
      // addressRegion, streetAddress }. Used to override the search-card
      // district when the JSON-LD street address has a sub-locality.
      const addr = rel.mainEntity && rel.mainEntity.address;
      if (addr && addr.streetAddress) {
        ad.street = this._decodeEntities(String(addr.streetAddress));
      }

      // numberOfRooms / floorLevel / yearBuilt — often null in JSON-LD
      // (lento's agents don't fill them in). Backfill from the params table
      // below.
    }

    // ---- 2. Coords (data-lat / data-lng) ----
    // The detail page emits `<div class="box-map-show" data-lat="..."
    // data-lng="...">` in the contact/location row. Sanity-bound to Poland
    // (lat 49-55, lng 14-24) to filter out any stray matches elsewhere.
    if (ad.lat == null || ad.lng == null) {
      const coords = this._extractCoordsFromHtml(s);
      if (coords) {
        ad.lat = coords.lat;
        ad.lng = coords.lng;
      }
    }

    // ---- 3. Params table (backfill) ----
    // `<span class="...label...">Powierzchnia:</span><span>43 m2</span>`.
    // Tolerant of class variations (the label class is sometimes "row-old",
    // sometimes "label", sometimes inline).
    const params = this._extractParamsTable(s);
    if (params.area != null && params.area > 0) ad.area = params.area;
    if (params.rooms != null && params.rooms > 0) ad.rooms = params.rooms;
    if (params.floor != null) ad.floor = String(params.floor).trim();
    if (params.street) ad.street = params.street;

    // ---- 4. Description div (canonical source) ----
    // `<div class="desc text-15"><h3>Opis oferty</h3>FULL TEXT</div>`.
    // Always present in the HTML — used even when JSON-LD description is
    // present, because the visible div carries the agent's full Polish text
    // (line breaks preserved from <br> and </p>). When JSON-LD is missing
    // (verified on listing 16118509 — no RealEstateListing block at all),
    // this div is the SOLE description source.
    const descText = this._extractDescriptionDiv(s);
    if (descText && descText.length > (ad.description || '').length) {
      ad.description = descText;
    }

    // ---- 5. Location row → real district ----
    // `<div class="licon-pin-f margin-bottom-5">Warszawa / Ursynów</div>`
    // or `Warszawa / Ursynów` format (city / district). Split on `/` to
    // get the sub-locality; override the search-card district only when a
    // sub-locality is present.
    const locRow = this._extractLocationRow(s);
    if (locRow) {
      const parts = locRow.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[1] && parts[1].toLowerCase() !== city_name(ad).toLowerCase()) {
        ad.district = parts[1];
        ad.address = `${parts[1]}, ${parts[0]}`;
      } else if (parts.length >= 1 && parts[0]) {
        // Just the city — leave district as the search-card value.
      }
    }

    // ---- 6. Conveniences ----
    // Lento exposes amenities as the "Inf. dodatkowe" params field
    // (comma-separated: "Balkon, Winda, Miejsce parkingowe, Garaż"). We map
    // Polish amenity labels → our internal types (mirrors wynajem24's
    // _inferConveniences convention). Fall back to description grep when
    // the params field is empty.
    if ((!ad.conveniences || !ad.conveniences.length)) {
      ad.conveniences = this._inferConveniences(s, ad.description);
    }

    // Save the publisher + raw params for the dedupe/translate pipeline.
    ad.raw = ad.raw || {};
    if (params.rawParams && params.rawParams.length) {
      ad.raw.params = params.rawParams;
    }
    if (params.sellerType) {
      ad.raw.searchCard = ad.raw.searchCard || {};
      ad.raw.searchCard.sellerType = params.sellerType;
    }
  }

  // Find the JSON-LD block whose @type is RealEstateListing on a detail
  // page. Lento emits the block as a single object (not a @type array).
  // Returns null when the block is missing (verified on ~30-40% of listings).
  _extractRealEstateListingBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      // Lento emits a single block per script tag, but tolerate @type arrays
      // defensively (some sites wrap @type as ["RealEstateListing"]).
      const t = b && b['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes('RealEstateListing')) {
        // Must have either an `offers` block with a price OR an `image`[]
        // OR a `geo` block to be a real listing (weeds out generic blocks).
        if (b && (b.offers || (b.image && b.image.length) || b.geo || b.description)) {
          return b;
        }
      }
    }
    return null;
  }

  // Extract lat/lng from the detail-page HTML. Two sources:
  //   - `<div class="box-map-show" data-lat="..." data-lng="...">` attribute
  //   - `lat="..." lng="..."` standalone attributes (older template)
  // Sanity-bound to Poland (lat 49-55, lng 14-24).
  _extractCoordsFromHtml(html) {
    const m = html.match(/data-lat="([\d.]+)"[^>]*data-lng="([\d.]+)"/i);
    if (!m) {
      // Try reversed attribute order (data-lng before data-lat).
      const m2 = html.match(/data-lng="([\d.]+)"[^>]*data-lat="([\d.]+)"/i);
      if (!m2) return null;
      const lat = parseFloat(m2[2]);
      const lng = parseFloat(m2[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) &&
          lat >= 49 && lat <= 55 && lng >= 14 && lng <= 24) {
        return { lat, lng };
      }
      return null;
    }
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < 49 || lat > 55 || lng < 14 || lng > 24) return null;
    return { lat, lng };
  }

  // Extract the params table from the detail page. The list of
  // `<span class="...label...">Label:</span><span class="...">Value</span>`
  // pairs carries Powierzchnia (area), Liczba pokoi (rooms), Piętro (floor),
  // Liczba pięter (building floor count), Zabudowa (building type), Forma
  // kuchni (kitchen form), Sprzedaż (seller type), Czynsz (monthly fees),
  // Inf. dodatkowe (additional info / amenities). We map the keys we care
  // about to our schema; the full list is preserved in rawParams for the
  // translate pipeline.
  _extractParamsTable(html) {
    const out = {
      area: null, rooms: null, floor: null, street: null,
      sellerType: null, rawParams: []
    };
    // Tolerant regex: the label span's class varies (`label`, `row-label`,
    // `param-list-atrr-item-label`, etc.) — we just match the label-span +
    // value-span pair pattern, with optional whitespace between them.
    // The label ends with a colon; the value lives in the next span.
    const re = /<span[^>]*class="[^"]*(?:label|row-label)[^"]*"[^>]*>\s*([^<:]+?:?)\s*<\/span>\s*<span[^>]*class="[^"]*"[^>]*>\s*([^<]*?)\s*<\/span>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const label = this._decodeEntities(m[1]).replace(/:$/, '').trim();
      const value = this._decodeEntities(m[2]).trim();
      if (!label || !value) continue;
      out.rawParams.push({ key: label, value });
      const lv = label.toLowerCase();
      if (lv === 'powierzchnia') {
        out.area = parseNum(value);
      } else if (lv === 'liczba pokoi') {
        const n = parseRooms(value);
        if (n != null && n > 0) out.rooms = n;
      } else if (lv === 'piętro' || lv === 'pietro') {
        // "3 piętro" → "3"
        const fm = value.match(/^(\d+)/);
        out.floor = fm ? fm[1] : value;
      } else if (lv === 'ulica' || lv === 'adres') {
        out.street = value;
      } else if (lv === 'sprzedaż' || lv === 'sprzedaz') {
        out.sellerType = value;
      }
    }
    return out;
  }

  // Extract the full Polish description from `<div class="desc text-15">
  // <h3>Opis oferty</h3>FULL TEXT</div>`. This div is always present in the
  // detail-page HTML (verified on listings 15671025 and 16118509), even
  // when the JSON-LD RealEstateListing block is missing. We strip HTML tags
  // preserving <br> as newlines.
  _extractDescriptionDiv(html) {
    // Locate the div opener, then walk forward to the matching </div>.
    // The div contains a single <h3>Opis oferty</h3> header followed by
    // the agent-written Polish text (with <br>, <p>, and inline tags).
    const startRe = /<div[^>]*class="[^"]*desc[^"]*text-15[^"]*"[^>]*>\s*(?:<h3[^>]*>[^<]*<\/h3>)?([\s\S]*?)<\/div>\s*(?:<div|<ul|<\/div)/i;
    const m = html.match(startRe);
    if (!m) return null;
    const inner = m[1];
    if (!inner || inner.trim().length < 30) return null;
    // Strip tags + decode entities. Preserve <br> and </p> as \n.
    const text = inner
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
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
    return text || null;
  }

  // Extract the location row text from the detail page. The pattern is:
  //   <div class="licon-pin-f margin-bottom-5">Warszawa / Ursynów</div>
  // or `<div class="...licon-pin-f...">Warszawa</div>` for plain listings.
  // Returns the inner text (e.g. "Warszawa / Ursynów") or null.
  _extractLocationRow(html) {
    // The detail page emits the real location in a div like:
    //   <div class="... licon-pin-f margin-bottom-5">Warszawa / Ursynów <span ...>
    // (the `<span class="box-map-show" ...>` follows the location text).
    // The text "Warszawa / Ursynów" is followed by an opening `<span>` tag
    // (NOT a closing tag), so we match text up to the first `<` after the
    // opening div. Similar-listings widgets elsewhere on the page use
    // `licon-pin-f pull-right` (without `margin-bottom-5`), so the
    // `margin-bottom-5` class is the discriminator.
    const re = /<[^>]*class="[^"]*licon-pin-f[^"]*margin-bottom-5[^"]*"[^>]*>\s*([^<]+?)\s*</i;
    const m = html.match(re);
    if (!m) return null;
    return this._decodeEntities(m[1]);
  }

  // Infer conveniences from the "Inf. dodatkowe" params field + the listing
  // description text. Lento doesn't emit a structured amenity list beyond
  // the comma-separated Inf. dodatkowe field — we grep both that field and
  // the description for Polish keywords (balkon, garaż, winda, parking,
  // piwnica, metro, tramwaj, etc.). Mirrors sprzedajemy's _inferConveniences.
  _inferConveniences(html, description) {
    const conv = [];
    const seen = new Set();
    const allText = `${description || ''} ${this._extractAmenitiesField(html) || ''}`.toLowerCase();

    const add = (type, label) => {
      if (seen.has(type)) return;
      seen.add(type);
      conv.push({ type, label });
      if (conv.length >= 12) return; // persistListing cap
    };

    if (/\b(balkon|loggia|taras)\b/.test(allText)) add('balcony', 'Balkon');
    if (/\bgara[sz]\b/.test(allText)) add('garage', 'Garaż');
    if (/\bogr[oó]dek\b|\bogr[oó]d\b/.test(allText)) add('garden', 'Ogródek');
    if (/\b(parking|miejsce parkingowe|stanowisko)\b/.test(allText)) add('park', 'Parking');
    if (/\bwinda\b/.test(allText)) add('lift', 'Winda');
    if (/\bpiwnica|kom[oó]rka\b/.test(allText)) add('cellar', 'Piwnica');
    if (/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/.test(allText)) {
      const mm = allText.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/);
      if (mm) add('market', `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby`);
    }
    if (/\b(metro|tramwaj|autobus|stacja|przystanek)\b/.test(allText)) {
      const mm = allText.match(/\b(metro|tramwaj|autobus)\b/);
      if (mm) add('transport', `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby`);
    }
    if (/\b(internet|wi-?fi|światłowod)\b/.test(allText)) add('internet', 'Internet');
    if (/\btelewizor|\btv\b|telewizj/.test(allText)) add('tv', 'TV');
    if (/\bklimatyz/.test(allText)) add('ac', 'Klimatyzacja');
    if (/\bmeble|umeblow/.test(allText)) add('furniture', 'Meble');
    if (/\bzwierz|pets/.test(allText)) add('pets', 'Zgoda na zwierzęta');
    if (/\bpralka/.test(allText)) add('washer', 'Pralka');
    if (/\blod[óo]wka/.test(allText)) add('fridge', 'Lodówka');
    if (/\bzmywarka/.test(allText)) add('dishwasher', 'Zmywarka');
    if (/\bpiekarnik/.test(allText)) add('oven', 'Piekarnik');
    return conv;
  }

  // Extract the "Inf. dodatkowe" comma-separated amenities field from the
  // detail page's params table. Returns the raw string (e.g.
  // "Balkon, Winda, Miejsce parkingowe, Garaż") or null when absent.
  _extractAmenitiesField(html) {
    const re = /<span[^>]*class="[^"]*(?:label|row-label)[^"]*"[^>]*>\s*Inf\.?\s*dodatkowe:?\s*<\/span>\s*<span[^>]*class="[^"]*"[^>]*>\s*([^<]*?)\s*<\/span>/i;
    const m = html.match(re);
    if (!m) return null;
    return this._decodeEntities(m[1]);
  }

  // Strip tracking/marketing query params so the same listing always produces
  // the same stored URL (mirrors the olx/domiporta/ofertyNet/sprzedajemy/
  // wynajem24 pattern). Lento's listing URLs are clean by default
  // (`/<slug>,<id>.html` with no query string), but normalizing defensively
  // protects against future regressions and against imported URLs with
  // utm_*/fbclid etc.
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
