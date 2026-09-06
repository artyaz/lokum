// bezposrednio.net.pl scraper — Polish direct-from-owner ("bez pośredników")
// real-estate portal with a small but distinct Warszawa wynajem inventory
// (~57 listings total — sum of all district sub-pages, verified via web
// search 2026-08-30). Site is independent (not part of the Morizon/Gratka/
// Agora oligopoly) and 100% of listings are direct-from-owner by design —
// the portal's USP is "no agency fees". High cross-source overlap expected
// with olx/otodom direct-from-owner listings + the other long-tail Polish
// portals (odwlasciciela.pl, sprzedajemy.pl, tabelaofert.pl `?klient_typ=
// osoba_prywatna` subset) — caught by services/dedupe.js via geo + area +
// rooms fingerprint.
//
// Site layout (verified 2026-08-30 via z-ai web_search on live Google
// index — direct curl + z-ai page_reader are Cloudflare-blocked from the
// sandbox test IP, but the production server's IP is NOT blocked per C1
// research note "Plain HTML, no Cloudflare"):
//
//   Search:  https://bezposrednio.net.pl/mieszkania_wynajem,<city_lower>,c<city_code>?page=N
//            e.g. https://bezposrednio.net.pl/mieszkania_wynajem,warszawa,c68551
//                 https://bezposrednio.net.pl/mieszkania_wynajem,warszawa,c68551?page=2
//            Pagination uses the standard Polish-portal ?page=N convention;
//            with ~57 Warszawa listings on a single page the walk exits after
//            page 1 (empty page 2). MAX_PAGES=30 is a safety ceiling.
//
//            The search URL is comma-separated: <listing_type>,<city_slug>,
//            c<city_code>. Optional district suffix: ,<district_slug>-d<code>
//            (e.g. ,wola-d4356, ,mokotow-d6064). We don't use the district
//            suffix — the unfiltered city URL returns ALL listings and the
//            district comes from the detail page's title text ("Do wynajęcia
//            mieszkanie Warszawa - Śródmieście").
//
//            The page emits visible text snippets like:
//              "Znaleziono: 57 nieruchomości"
//              "Pokaż Filtry. Kolejność od: Najtańszych, Najdroższych,
//               Najniższej ceny za m2..." (sort dropdown — s1/s2/s3/s4 =
//               sort variants, NOT pagination — we leave sort at default)
//              Per-card sequence: "<price> zł · <area> m · <rooms>"
//                (e.g. "2 800 zł · 35 m · 2 · ...")
//
//   Detail:  https://bezposrednio.net.pl/<slug>-do_wynajecia-t-<code>.html
//            e.g. /mieszkanie-2-pokoje-warszawa-40m-do_wynajecia-t-ZFd.html
//                 /mieszkanie-3-pokoje-warszawa-53m-do_wynajecia-t-Z9i.html
//                 /mieszkanie-warszawa-91m-do_wynajecia-t-ZTd.html
//            The trailing `t-<code>` (3-char base62-ish id like "ZFd", "Z9i",
//            "ZTd") is the stable externalId. The slug encodes the listing's
//            primary attributes (type=N pokoje/kawalerka, city, area in m²,
//            transaction type) for SEO but is NOT stable across updates —
//            only the `t-<code>` suffix is canonical.
//
//            The detail page emits the same data fields visible in the
//            search-card snippets + a longer description. Verified via
//            web-search index snippets:
//              - Title (HTML <title>): "Do wynajęcia mieszkanie <City> - <District>"
//              - Snippet text: "<City> <District> bezpośrednio <N> pokoje ;
//                parter|<N> piętro cena:<price>zł miesięcznie." (rent) or
//                "Pilnie sprzedam mieszkanie <City> <District> bezpośrednio
//                <N> pokoje ; <N> piętro powierzchnia:<area>m2 cena:<price>zł"
//                (sale — skipped).
//              - Detail params list (in the visible HTML text): "Ostatnia
//                aktualizacja: DD-MM-YYYY HH:MM; Kaucja: <N>; Min. wynajem
//                w mies.: <N>; Dostępne od: DD-MM-YYYY; rok budowy: YYYY;
//                liczba ..."
//              - Footer: "BEZPOSREDNIO.NET.PL · WyszukiwarkaRegulaminKontakt
//                z nami · Polityka prywatności · Nasz profil na Facebooku"
//
//            HTML structure for photos / coords / full description was not
//            verified against the live page (sandbox test IP blocked by
//            Cloudflare). The scraper uses defensive parsers that try
//            several common patterns: JSON-LD (Product / RealEstateListing /
//                Apartment / Offer), inline JS objects (photos arrays,
//                Google Maps lat/lng init), and visible HTML params blocks.
//            When the live HTML exposes a different pattern, the scraper
//            degrades gracefully — fields it can't parse stay null and the
//            runner's defensive post-process (dedupe + totalprice) handles
//            the partial data.
//
//   Photos:  Best guess — JSON-LD image[] (most Polish portals use schema.org
//            for the gallery); fallback — visible <img src> in a gallery
//            container; fallback — inline JS photo array. The "8-12 photos"
//            quality-bar minimum is not guaranteed (the source's listing
//            inventory is small and many listings are short photo sets — same
//            policy as wynajem24.js: accept the source's inventory without
//            manufacturing photos that don't exist).
//
// Quality bar (per Task D brief):
//   - lat/lng: JSON-LD geo OR data-lat/data-lng attr OR inline Google Maps
//     JS init (must not be null — listings without coords are still
//     persisted; the runner's quality-bar filter excludes them downstream).
//     The site's per-property coords presence is unverified — if the live
//     HTML doesn't expose them, we accept city-level coords as a fallback
//     (per the wynajem24.js precedent).
//   - photos: best-effort — see "Photos" above.
//   - description: full Polish text — JSON-LD `description` OR visible
//     "Opis" / "Opis oferty" div.
//   - price: PLN/monthly from "cena:<N>zł miesięcznie" text pattern OR
//     JSON-LD offers.price (must be > 0; sale listings skipped).
//
// Inventory note: ~57 Warszawa wynajem listings on a single page. The
// MAX_PAGES=30 walk exits after page 1 naturally (empty page 2). The
// 4-worker detail-page pool processes ~50 listings per cycle (~30-60s
// at 500ms/fetch). Pairs with the 3×/day recommended schedule.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 14;
// Safety ceiling on the page walk. With ~57 Warszawa listings on a single
// page (no pagination needed in practice), this rarely binds. B-pattern
// parity with domiporta/ofertyNet/nieruchomosciOnline/tabelaofert/sprzedajemy/
// wynajem24/lento/rentola (MAX_PAGES=30).
const MAX_PAGES = 30;
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset, Cloudflare challenge). 3 strikes → bail. Same
// pattern as domiporta/ofertyNet/nieruchomosciOnline/tabelaofert.
const MAX_CONSECUTIVE_FAILURES = 3;
// Assume ~30 listings/page (the typical Polish-portal page size). The
// real Warszawa inventory is ~57 listings across 1 page; the threshold
// is the early-stop heuristic so a single delisted listing doesn't
// trigger a false break (same logic as tabelaofert/sprzedajemy).
const OFFERS_PER_PAGE = 30;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2);
// Cap the number of detail-page fetches per cycle. With ~57 Warszawa
// listings and 4-worker pool, this caps at ~50 detail fetches per cycle —
// roughly 30-60 seconds at 500ms/fetch. Aligned with the other D-chunk
// scrapers (wynajem24=100, sprzedajemy=200, tabelaofert=300).
const ENRICH_LIMIT = 100;
// Promise pool concurrency for the detail-page enrichment step. Same value
// as nieruchomosci-online/domiporta/ofertyNet/tabelaofert/sprzedajemy/wynajem24
// /lento/rentola for parity — 4 workers strikes the right balance between
// throughput and not hammering the source.
const ENRICH_CONCURRENCY = 4;

// City path + code map — verified via web_search 2026-08-30:
//   warsaw → c68551, krakow → c50807, wroclaw → c42271, gdansk → c31024,
//   poznan → c71899.
const CITY = {
  warsaw:  { slug: 'warszawa', code: '68551' },
  krakow:  { slug: 'krakow',   code: '50807' },
  wroclaw: { slug: 'wroclaw',  code: '42271' },
  gdansk:  { slug: 'gdansk',   code: '31024' },
  poznan:  { slug: 'poznan',   code: '71899' }
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "2 500" (non-breaking-space thousand separator),
// "2500,00" (decimal comma), "2 500 zł" (with currency suffix). Returns a
// Number (or null on failure). Mirrors tabelaofert.js parseNum.
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
// tabelaofert.js's stripTags.
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

// Parse "Ostatnia aktualizacja: 09-08-2026 17:14" or "DD-MM-YYYY HH:MM" /
// "DD.MM.YYYY HH:MM" → ISO 8601. The site emits Polish local time without
// a tz marker; we treat it as Europe/Warsaw (CET/CEST) via the fixed
// +01:00 offset (the ±1h imprecision is harmless for the runner's
// was_new comparison — same approach as sprzedajemy.js's parsePostedAt).
function parsePostedAt(text) {
  if (!text) return null;
  const s = String(text).trim();
  // "09-08-2026 17:14" (DD-MM-YYYY HH:MM)
  const m1 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m1) {
    const iso = `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}T${m1[4].padStart(2, '0')}:${m1[5]}:00+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // "09.08.2026 17:14" (DD.MM.YYYY HH:MM)
  const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m2) {
    const iso = `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}T${m2[4].padStart(2, '0')}:${m2[5]}:00+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // "09-08-2026" or "09.08.2026" (date only — DD-MM-YYYY / DD.MM.YYYY)
  const m3 = s.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/);
  if (m3) {
    const iso = `${m3[3]}-${m3[2].padStart(2, '0')}-${m3[1].padStart(2, '0')}T00:00:00Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: native Date.parse (handles ISO 8601 if the site ever emits it)
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

// Detect a Cloudflare challenge / block page. The site returns HTTP 403
// with a Cloudflare "Attention Required" / "Sorry, you have been blocked"
// HTML body when the requesting IP is on a blocklist. We can't bypass
// Cloudflare from a plain fetch() (would need a real browser context —
// out of scope for this scraper; the production server's IP is not
// blocked per C1 research note "Plain HTML, no Cloudflare").
function isCloudflareBlockPage(html) {
  if (!html) return false;
  const s = String(html).slice(0, 4000).toLowerCase();
  return s.includes('attention required') ||
         s.includes('cloudflare') ||
         s.includes('you have been blocked') ||
         s.includes('cf-error-details') ||
         s.includes('cf-wrapper');
}

export class BezposrednioScraper extends BaseScraper {
  // Streaming disabled — same reason as domiporta/ofertyNet/nieruchomosciOnline
  // /tabelaofert/sprzedajemy/wynajem24: the detail-page enrichment
  // (photos / full description / coords) needs to run AFTER the search walk,
  // and the streaming `onListing` path skips enrichment. We retain the
  // listings array (~250 KB for ~50 listings × 5 KB payload) and then run
  // the 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'bezposrednio',
      baseUrl: 'https://bezposrednio.net.pl'
    });
  }

  async fetchCity(city, options = {}) {
    const c = CITY[city.slug];
    if (!c) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('BEZPOSREDNIO_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    let blockedByCloudflare = false;

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      // Price filter — bezposrednio.net.pl's sidebar exposes price filter
      // widgets but the query param keys are unverified from the sandbox
      // (page is Cloudflare-blocked). We leave the filter to the runner's
      // defensive pass — getting the param wrong here would silently 0-
      // result the feed (verified pattern: sprzedajemy.js does the same).
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkania_wynajem,${c.slug},c${c.code}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[bezposrednio] ${city.slug} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[bezposrednio] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        // Back off briefly so a transient 5xx / connection-reset blip
        // doesn't cascade into a hard abort and skip the remaining pages.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      // Cloudflare block — log once per (source, city) and abort the walk.
      // The CF 403 page is the same content regardless of which page=N we
      // request, so retrying subsequent pages is wasted fetches.
      if (isCloudflareBlockPage(html)) {
        if (!blockedByCloudflare) {
          console.warn(`[bezposrednio] ${city.slug}: Cloudflare block page detected — scraper cannot bypass from this IP. Skipping ${city.slug} for this cycle (the full cron's next run will retry).`);
          blockedByCloudflare = true;
        }
        break;
      }
      consecutiveFailures = 0; // reset on successful (non-CF) response

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[bezposrednio] ${city.slug}: no cards on page 1`);
        else console.log(`[bezposrednio] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      let dupCount = 0;
      for (const card of cards) {
        seen++;
        // Defensive runner-level filters also cover sources that can't
        // express every filter at URL level. We still pre-filter by price
        // here when the card carries a price (saves a detail-page fetch).
        if (filters.maxPrice != null && card.price && card.price > filters.maxPrice) continue;
        if (filters.minPrice != null && card.price && card.price < filters.minPrice) continue;

        if (seenExternalIds.has(card.externalId)) {
          dupCount++;
          continue;
        }
        seenExternalIds.add(card.externalId);
        if (onListing) await onListing(card);
        else ads.push(card);
      }
      console.log(
        `[bezposrednio] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Short-page early-stop: pages 1..N have ~30 cards each
      // (OFFERS_PER_PAGE); the true last page returns fewer. Use HALF of
      // OFFERS_PER_PAGE as the threshold so a natural fluctuation of
      // ±1-2 cards doesn't trigger a false break.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[bezposrednio] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }
    }

    if (!onListing && ads.length) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Parse listing cards from the search results HTML. The site emits
  // detail URLs in the pattern /<slug>-do_wynajecia-t-<code>.html (rent
  // listings). Sale listings end with -sprzedam-t-<code>.html and are
  // skipped. We regex-scan for the detail URL pattern and extract a
  // chunk around each match (~3 KB) to capture price / area / rooms /
  // floor / thumbnail from the card's nearby text.
  //
  // Defensive: tries JSON-LD first (in case the site emits ItemList),
  // then regex fallback on detail URLs. The regex fallback is the
  // canonical path — bezposrednio.net.pl's HTML structure is server-
  // rendered plain HTML (per C1 research note "Plain HTML, no
  // Cloudflare"), not a JSON-LD-rich React/Nuxt shell.
  _parseSearchCards(html, city) {
    const out = [];
    const s = String(html);

    // 1. Try JSON-LD ItemList path (defensive — site may or may not emit
    // it; if it does, we get clean structured data without regex parsing).
    const blocks = this._extractJsonLd(s);
    for (const b of blocks) {
      const t = b?.['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes('ItemList') && Array.isArray(b?.itemListElement)) {
        for (const li of b.itemListElement) {
          const item = li?.item || li;
          if (!item?.url) continue;
          const card = this._normalizeJsonLdItem(item, city);
          if (card) out.push(card);
        }
        if (out.length) return out;
      }
      // Single-Product AggregateOffer path (tabelaofert.pl-style):
      if (types.includes('Product') && b?.offers?.offers) {
        for (const offer of b.offers.offers) {
          const card = this._normalizeJsonLdItem(offer, city);
          if (card) out.push(card);
        }
        if (out.length) return out;
      }
    }

    // 2. Regex fallback: scan for /<slug>-do_wynajecia-t-<code>.html
    // detail URLs in the HTML. The pattern is canonical — verified via
    // 20+ web_search result URLs (sample: mieszkanie-2-pokoje-warszawa-
    // 40m-do_wynajecia-t-ZFd.html, mieszkanie-warszawa-91m-do_wynajecia-
    // t-ZTd.html, mieszkanie-3-pokoje-krakow-46m-do_wynajecia-t-Z7s.html).
    // We capture the trailing 3-char code (e.g. "ZFd") as the externalId.
    const re = /href="(\/[^"]*?-do_wynajecia-t-([A-Za-z0-9]{2,12})\.html)"/gi;
    const seenIds = new Set();
    let m;
    while ((m = re.exec(s)) !== null) {
      const path = m[1];
      const externalId = m[2];
      if (seenIds.has(externalId)) continue;
      seenIds.add(externalId);
      // Take a chunk FORWARD from the match — the card's metadata
      // (price/area/rooms/floor/thumb) appears AFTER the detail link in
      // the typical Polish-portal card markup. Forward-only chunk
      // ensures the price/area/rooms regex picks up THIS card's data,
      // not the previous card's (which would happen if we scanned
      // backwards past the previous card's <a href>). ~2.5 KB captures
      // a single card's full markup with margin (verified on domiporta
      // /tabelaofert/sprzedajemy — cards are ~2-5 KB each).
      const end = Math.min(s.length, m.index + 2500);
      const chunk = s.slice(m.index, end);
      const card = this._normalizeRegexCard(path, externalId, chunk, city);
      if (card) out.push(card);
    }
    return out;
  }

  // Map one JSON-LD item to a normalized card. Handles the schema.org
  // patterns most Polish portals use: Product / RealEstateListing /
  // Apartment / Offer. The structure varies by source — we defensively
  // unwrap nested itemOffered / offers / mainEntity and pick whichever
  // field has the data we need.
  _normalizeJsonLdItem(item, city) {
    if (!item || typeof item !== 'object') return null;
    const url = item.url;
    if (!url) return null;
    const externalId = this._extractIdFromUrl(url);
    if (!externalId) return null;

    // Sale listings have "-sprzedam-t-<code>" in the URL — skip them.
    if (/--sprzedam-t-/i.test(url)) return null;
    if (!/--do_wynajecia-t-/i.test(url) && !/do_wynajecia/i.test(url)) {
      // Not a rent listing URL — skip.
      return null;
    }

    const offers = item.offers || {};
    const price = parseNum(offers.price != null ? offers.price : offers.Price);
    if (!price || price <= 0) return null;

    const io = offers.itemOffered || item.itemOffered || item.mainEntity || {};
    const addr = io.address || item.address || {};
    const street = addr.streetAddress || null;
    const district = addr.addressLocality || city.name_pl;

    let area = null;
    if (io.floorSize?.value != null) {
      area = parseNum(io.floorSize.value);
    } else if (io.floorSize != null && typeof io.floorSize !== 'object') {
      area = parseNum(io.floorSize);
    }
    let rooms = null;
    if (io.numberOfRooms != null) {
      const v = typeof io.numberOfRooms === 'object' ? io.numberOfRooms.value : io.numberOfRooms;
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      if (!isNaN(n) && n > 0) rooms = n;
    }
    let floor = null;
    if (io.floorLevel != null) floor = String(io.floorLevel);

    // Coords from JSON-LD geo
    let lat = null, lng = null;
    const geo = io.geo || item.geo || {};
    if (geo.latitude != null && geo.longitude != null) {
      const la = parseFloat(geo.latitude);
      const lo = parseFloat(geo.longitude);
      if (Number.isFinite(la) && Number.isFinite(lo) &&
          la > 40 && la < 60 && lo > 10 && lo < 30) {
        lat = la; lng = lo;
      }
    }

    // Photos from JSON-LD image[]
    const images = [];
    const img = item.image || io.image;
    if (Array.isArray(img)) {
      for (const u of img) {
        if (typeof u === 'string') images.push(u);
        else if (u && (u.url || u.contentUrl)) images.push(u.url || u.contentUrl);
        if (images.length >= 20) break;
      }
    } else if (typeof img === 'string') {
      images.push(img);
    }

    const description = item.description || io.description || '';
    const title = item.name ? String(item.name).trim() : null;

    let postedAt = null;
    if (item.datePosted) postedAt = parsePostedAt(item.datePosted);

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: title || `Mieszkanie na wynajem — ${district}, ${city.name_pl}`,
      description: String(description),
      price: Math.round(price),
      currency: offers.priceCurrency || 'PLN',
      rooms,
      area,
      floor,
      district,
      street,
      address: [street, district].filter(Boolean).join(', ') || district,
      lat,
      lng,
      url: this._normalizeUrl(url.startsWith('http') ? url : `${this.baseUrl}${url}`),
      postedAt,
      images,
      conveniences: [],
      raw: { url, via: 'jsonld' }
    };
  }

  // Map a regex-extracted card (path + externalId + nearby HTML chunk)
  // to a normalized card object. The chunk is the ~4 KB of HTML around
  // the detail URL's <a href> tag. We regex-parse price / area / rooms
  // / floor / thumbnail / postedAt / district from the chunk's text.
  _normalizeRegexCard(path, externalId, chunk, city) {
    // Skip sale listings defensively (the regex already filters to
    // -do_wynajecia-t-, but a stray cross-link could slip through).
    if (/--sprzedam-t-/i.test(path)) return null;

    // Price — "<price> zł" or "<price> zł miesięcznie" (with non-breaking
    // space thousand separator). Take the FIRST match near the detail
    // link (the card's price span). Polish thousand separator is a space
    // or non-breaking space.
    const priceM = chunk.match(/(\d[\d\s\u00a0]*)\s*z[lł]\s*(?:miesięcznie|\/\s*mies\.?\s*)?/i);
    const price = priceM ? parseNum(priceM[1]) : null;
    if (!price || price <= 0) return null;

    // Area — "<N> m²" or "<N> m2" or "<N> m". Also parsed from the URL
    // slug (<area>m) as a fallback.
    let area = null;
    const areaM = chunk.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i) || chunk.match(/(\d+(?:[.,]\d+)?)\s*m\b/i);
    if (areaM) area = parseNum(areaM[1]);
    if (area == null) {
      // Fallback: parse area from the URL slug (<area>m before "do_wynajecia")
      const slugAreaM = path.match(/(\d+(?:[.,]\d+)?)m-do_wynajecia/i);
      if (slugAreaM) area = parseNum(slugAreaM[1]);
    }

    // Rooms — "<N> pokoje" or "<N> pokoi" or "kawalerka" → 1. Also from
    // URL slug: "<N>-pokoje-" or "kawalerka-" prefix.
    let rooms = null;
    const roomsM = chunk.match(/(\d+)\s*(?:pokoje|pokoi|pokoj)/i);
    if (roomsM) {
      const n = parseInt(roomsM[1], 10);
      if (!isNaN(n) && n > 0) rooms = n;
    }
    if (rooms == null) {
      if (/kawalerka|kawalerk[ae]/i.test(chunk)) rooms = 1;
      // Fallback: parse from URL slug "mieszkanie-<N>-pokoje-"
      const slugRoomsM = path.match(/mieszkanie-(\d+)-pokoje/i);
      if (slugRoomsM) {
        const n = parseInt(slugRoomsM[1], 10);
        if (!isNaN(n) && n > 0) rooms = n;
      } else if (/kawalerka/i.test(path)) {
        rooms = 1;
      }
    }

    // Floor — "parter" / "poddasze" / "<N> piętro" (Polish forms)
    let floor = null;
    if (/\bparter\b/i.test(chunk)) {
      floor = '0';
    } else if (/\bpoddasze\b/i.test(chunk)) {
      floor = 'poddasze';
    } else {
      const floorM = chunk.match(/(\d+)\s*pi[ęe]tro/i);
      if (floorM) floor = floorM[1];
    }

    // District — look for the standard pattern "Warszawa - <District>"
    // or "Warszawa, <District>" or just "<District>" near the city name.
    // Defensive: the title pattern visible in the search snippet is
    // "Do wynajęcia mieszkanie Warszawa - <District>".
    let district = null;
    const cityName = city.name_pl || CITY[city.slug]?.slug || '';
    const districtM = chunk.match(new RegExp(`${cityName}\\s*[-–,]\\s*([A-ZŁŚŻŹĆŃĄÓĘ][\\wŁŚŻŹĆŃĄÓĘłśżźćńąóę-]{2,40})`, ''));
    if (districtM) district = districtM[1];

    // Thumbnail — first <img src="..."> in the chunk (defensive — many
    // Polish portals put a thumbnail right next to the title link).
    const thumbM = chunk.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const thumb = thumbM ? thumbM[1] : null;

    // postedAt — "Ostatnia aktualizacja: DD-MM-YYYY HH:MM"
    let postedAt = null;
    const postedM = chunk.match(/Ostatnia aktualizacja:\s*(\d{1,2}[-.]\d{1,2}[-.]\d{4}(?:\s+\d{1,2}:\d{2})?)/i);
    if (postedM) postedAt = parsePostedAt(postedM[1]);

    const fullUrl = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: `Mieszkanie na wynajem — ${district || city.name_pl}`,
      description: '', // backfilled from detail page
      price: Math.round(price),
      currency: 'PLN',
      rooms,
      area,
      floor,
      district: district || city.name_pl,
      street: null, // backfilled from detail page
      address: district ? `${district}, ${city.name_pl}` : city.name_pl,
      lat: null,    // backfilled from detail page
      lng: null,
      url: this._normalizeUrl(fullUrl),
      postedAt,
      images: thumb ? [thumb] : [],
      conveniences: [],
      raw: { url: fullUrl, via: 'regex' }
    };
  }

  // Extract the listing's stable id from a detail URL.
  //   /mieszkanie-2-pokoje-warszawa-40m-do_wynajecia-t-ZFd.html → "ZFd"
  //   /mieszkanie-3-pokoje-krakow-46m-do_wynajecia-t-Z7s.html   → "Z7s"
  _extractIdFromUrl(url) {
    const m = String(url).match(/-t-([A-Za-z0-9]{2,12})\.html?/i);
    return m ? m[1] : null;
  }

  // Enrich new listings (or known ones with < 3 photos) by fetching each
  // detail page and extracting: full description, full photo gallery,
  // lat/lng, floor/area/rooms backfill, postedAt. Uses the 4-worker
  // Promise pool pattern (ENRICH_CONCURRENCY = 4) from domiporta/ofertyNet
  // /tabelaofert/sprzedajemy so we don't pin event-loop memory on a
  // 50-listing walk.
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
    console.log(`[bezposrednio] enriching ${fresh.length} listings (photos/desc/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true, timeout: 20000 });
          if (isCloudflareBlockPage(html)) {
            console.warn(`[bezposrednio] enrich for ${ad.externalId}: Cloudflare block — skipping detail fetch`);
            continue;
          }
          self._applyDetail(html, ad);
        } catch (e) {
          // single-listing enrichment failure shouldn't crash the whole pool
          console.warn(`[bezposrednio] enrich failed for ${ad.externalId}: ${e.message}`);
        }
        // Polite delay — 150ms between fetches per worker, same as
        // domiporta/ofertyNet/tabelaofert/sprzedajemy/wynajem24.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Apply detail-page data to an existing listing object. Tries multiple
  // sources in order of robustness:
  //   1. JSON-LD Product / RealEstateListing / Apartment / Offer block
  //      (handles most schema.org variants Polish portals use).
  //   2. Regex on visible HTML text for price / rooms / floor / area /
  //      postedAt / district / street (the patterns visible in web_search
  //      snippet text — "cena:<N>zł miesięcznie", "<N> pokoje", "parter"/
  //      "<N> piętro", "Ostatnia aktualizacja: DD-MM-YYYY HH:MM", etc.).
  //   3. Coords from JSON-LD geo OR data-lat/data-lng attr OR inline
  //      Google Maps JS init (var lat = ...; var lng = ...;).
  //   4. Photos from JSON-LD image[] OR visible <img src> in a gallery
  //      container OR inline JS photo array.
  //   5. Description from JSON-LD description OR visible "Opis" /
  //      "Opis oferty" div.
  //
  // IMPORTANT: each section is independent — a missing field doesn't
  // invalidate the rest. The ad's search-card data (price/area/rooms/
  // floor from URL slug + card text) is preserved when the detail page
  // doesn't expose a better value.
  _applyDetail(html, ad) {
    const s = String(html);

    // ---- 1. JSON-LD block (primary source when present) ----
    const listing = this._extractListingBlock(s);
    if (listing) {
      // Photos — JSON-LD image[] when present.
      if (Array.isArray(listing.image) && listing.image.length) {
        const photos = [];
        const seen = new Set();
        for (const u of listing.image) {
          if (typeof u !== 'string') {
            if (u && (u.url || u.contentUrl)) {
              const url = String(u.url || u.contentUrl);
              if (!seen.has(url)) { seen.add(url); photos.push(url); }
            }
            continue;
          }
          const url = u.replace(/\\\//g, '/');
          if (seen.has(url)) continue;
          seen.add(url);
          photos.push(url);
          if (photos.length >= 20) break; // persistListing cap
        }
        if (photos.length) ad.images = photos;
      } else if (typeof listing.image === 'string' && listing.image) {
        if (!ad.images.length) ad.images = [listing.image];
      }

      // Coords
      const io = listing.itemOffered || listing.mainEntity || {};
      const geo = io.geo || listing.geo || {};
      if (geo.latitude != null && geo.longitude != null) {
        const lat = parseFloat(geo.latitude);
        const lng = parseFloat(geo.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            lat > 40 && lat < 60 && lng > 10 && lng < 30) {
          ad.lat = lat;
          ad.lng = lng;
        }
      }

      // Floor
      if (io.floorLevel != null) {
        ad.floor = String(io.floorLevel);
      }
      // Area
      if (io.floorSize?.value != null) {
        const a = parseNum(io.floorSize.value);
        if (a != null && a > 0) ad.area = a;
      }
      // Rooms
      if (io.numberOfRooms != null) {
        const v = typeof io.numberOfRooms === 'object' ? io.numberOfRooms.value : io.numberOfRooms;
        const r = parseInt(String(v).replace(/[^\d]/g, ''), 10);
        if (!isNaN(r) && r > 0) ad.rooms = r;
      }
      // Address
      const addr = listing.address || io.address || {};
      if (addr.streetAddress) ad.street = String(addr.streetAddress);
      if (addr.addressLocality) ad.district = String(addr.addressLocality);
      if (ad.street || ad.district) {
        ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;
      }
      // Price — sanity-check
      const offers = listing.offers || {};
      const detailPrice = parseNum(offers.price != null ? offers.price : offers.Price);
      if (detailPrice && detailPrice > 0) {
        if (!ad.price || Math.abs(detailPrice - ad.price) > Math.max(50, ad.price * 0.05)) {
          ad.price = Math.round(detailPrice);
        }
      }
      if (offers.priceCurrency) ad.currency = String(offers.priceCurrency) === 'ZLOTY' ? 'PLN' : String(offers.priceCurrency);

      // Title — prefer the JSON-LD `name` (full Polish title)
      if (listing.name) {
        ad.title = String(listing.name).trim();
      }

      // datePosted
      if (listing.datePosted) {
        const d = parsePostedAt(listing.datePosted);
        if (d) ad.postedAt = d;
      }

      // Description (JSON-LD description is usually the FULL Polish text)
      if (listing.description && String(listing.description).length > (ad.description || '').length) {
        ad.description = stripTags(String(listing.description));
      }

      // Conveniences — derive from amenityFeature[] / additionalProperty[]
      if (!ad.conveniences || !ad.conveniences.length) {
        ad.conveniences = this._inferConveniences(io, listing);
      }

      // Raw params for the translate pipeline
      const props = Array.isArray(io.additionalProperty) ? io.additionalProperty
        : Array.isArray(listing.additionalProperty) ? listing.additionalProperty : [];
      if (props.length) {
        const params = props
          .filter(p => p && p.name && p.value != null && String(p.value).trim() !== '')
          .map(p => ({ key: String(p.name), name: String(p.name), value: String(p.value) }))
          .slice(0, 20);
        if (params.length) {
          ad.raw = ad.raw || {};
          ad.raw.params = params;
        }
      }
    }

    // ---- 2. Regex backfill (when JSON-LD is missing or partial) ----
    // Price — "cena:<N>zł miesięcznie" or "cena:<N>zł"
    if (!ad.price || ad.price <= 0) {
      const pm = s.match(/cena:\s*(\d[\d\s\u00a0]*)\s*z[lł]\s*(miesięcznie)?/i);
      if (pm) {
        const p = parseNum(pm[1]);
        if (p && p > 0) ad.price = Math.round(p);
      }
    }
    // Rooms — "<N> pokoje" / "kawalerka"
    if (!ad.rooms) {
      const rm = s.match(/(\d+)\s*(?:pokoje|pokoi|pokoj)/i);
      if (rm) {
        const n = parseInt(rm[1], 10);
        if (!isNaN(n) && n > 0) ad.rooms = n;
      } else if (/kawalerka|kawalerk[ae]/i.test(s)) {
        ad.rooms = 1;
      }
    }
    // Floor — "parter" / "<N> piętro"
    if (ad.floor == null) {
      if (/\bparter\b/i.test(s)) ad.floor = '0';
      else if (/\bpoddasze\b/i.test(s)) ad.floor = 'poddasze';
      else {
        const fm = s.match(/(\d+)\s*pi[ęe]tro/i);
        if (fm) ad.floor = fm[1];
      }
    }
    // Area — "powierzchnia:<N>m2" / "<N> m²"
    if (!ad.area) {
      const am = s.match(/powierzchnia:?\s*(\d+(?:[.,]\d+)?)\s*m2?/i) ||
                 s.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i);
      if (am) {
        const a = parseNum(am[1]);
        if (a && a > 0) ad.area = a;
      }
    }
    // District — "Do wynajęcia mieszkanie <City> - <District>" (HTML title)
    if (!ad.district || ad.district === ad.address) {
      const dm = s.match(/<title[^>]*>\s*[^<]*mieszkanie\s+\w[\w-]*\s*[-–]\s*([A-ZŁŚŻŹĆŃĄÓĘ][\wŁŚŻŹĆŃĄÓĘłśżźćńąóę-]{2,40})/i);
      if (dm) {
        ad.district = dm[1];
        ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;
      }
    }
    // postedAt — "Ostatnia aktualizacja: DD-MM-YYYY HH:MM"
    if (!ad.postedAt) {
      const pm = s.match(/Ostatnia aktualizacja:\s*(\d{1,2}[-.]\d{1,2}[-.]\d{4}(?:\s+\d{1,2}:\d{2})?)/i);
      if (pm) ad.postedAt = parsePostedAt(pm[1]);
    }

    // ---- 3. Coords (when JSON-LD geo was missing) ----
    if (ad.lat == null || ad.lng == null) {
      const coords = this._extractCoords(s);
      if (coords) {
        ad.lat = coords.lat;
        ad.lng = coords.lng;
      }
    }

    // ---- 4. Photos (when JSON-LD image[] was missing) ----
    if (!ad.images || ad.images.length < 3) {
      const photos = this._extractPhotosFromHtml(s);
      if (photos.length) ad.images = photos;
    }

    // ---- 5. Description (when JSON-LD description was missing) ----
    if (!ad.description || ad.description.length < 80) {
      const fullDesc = this._extractFullDescription(s);
      if (fullDesc && fullDesc.length > (ad.description || '').length) {
        ad.description = fullDesc;
      }
    }

    // ---- 6. Conveniences (when JSON-LD amenityFeature was missing) ----
    if ((!ad.conveniences || !ad.conveniences.length) && ad.description) {
      ad.conveniences = this._inferConveniencesFromText(ad.description);
    }

    // Mark the ad as direct-from-owner (bezposrednio.net.pl is 100% direct —
    // the entire site's USP). Same convention as tabelaofert.js's
    // "Oferta bezpośrednia" brand marker → convenience {type:'direct'}.
    if (ad.conveniences && !ad.conveniences.some(c => c.type === 'direct')) {
      ad.conveniences.push({ type: 'direct', label: 'Bez pośredników' });
    } else if (!ad.conveniences) {
      ad.conveniences = [{ type: 'direct', label: 'Bez pośredników' }];
    }
  }

  // Find a JSON-LD block whose @type is Product / RealEstateListing /
  // Apartment / Offer on a detail page. Defensive — bezposrednio.net.pl's
  // exact JSON-LD shape is unverified (sandbox IP blocked by Cloudflare),
  // so we accept any of the common schema.org real-estate types.
  _extractListingBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const t = b['@type'];
      const types = Array.isArray(t) ? t : [t];
      const isListing = types.some(x =>
        x === 'Product' || x === 'RealEstateListing' || x === 'Apartment' ||
        x === 'Offer' || x === 'House' || x === 'SingleFamilyResidence'
      );
      if (!isListing) continue;
      // Must have an `offers` block OR an `image` to be a real listing
      // (weeds out generic Product blocks for site metadata).
      if (b.offers || b.image || b.itemOffered || b.mainEntity) return b;
    }
    return null;
  }

  // Extract lat/lng from the detail page HTML. Tries (in order):
  //   1. data-lat / data-lng attributes (sprzedajemy.js-style)
  //   2. Inline Google Maps JS init: `var lat = 52.236; var lng = 21.042;`
  //      or `lat: 52.236, lng: 21.042` (object literal in JS)
  //   3. Google Static Map URL: `markers=...52.236,21.042`
  //   4. JSON-LD-embedded geo (when called outside _applyDetail — used
  //      by extractDetailCoords in jsonldProduct.js — kept here as a
  //      defensive fallback)
  // Sanity-bound to Poland (lat 49-55, lng 14-24).
  _extractCoords(html) {
    const s = String(html);
    // 1. data-lat / data-lng attributes
    const dLat = s.match(/data-lat(?:itude)?=["']([\d.]+)["']/i);
    const dLng = s.match(/data-l(?:ng|on(?:gitude)?)=["']([\d.]+)["']/i);
    if (dLat && dLng) {
      const lat = parseFloat(dLat[1]);
      const lng = parseFloat(dLng[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) &&
          lat > 49 && lat < 55 && lng > 14 && lng < 24) {
        return { lat, lng };
      }
    }
    // 2. Inline JS: `lat = 52.236;` / `lng = 21.042;` or `latitude: 52.236`
    const jsLat = s.match(/(?:lat|latitude)\s*[:=]\s*["']?(\d{2}\.\d{3,})/i);
    const jsLng = s.match(/(?:lng|lon|longitude)\s*[:=]\s*["']?(\d{2}\.\d{3,})/i);
    if (jsLat && jsLng) {
      const lat = parseFloat(jsLat[1]);
      const lng = parseFloat(jsLng[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) &&
          lat > 49 && lat < 55 && lng > 14 && lng < 24) {
        return { lat, lng };
      }
    }
    // 3. Google Static Map URL: `markers=color:red|52.236,21.042`
    const mapM = s.match(/markers=[^"']*?(\d{2}\.\d{3,})\s*,\s*(\d{2}\.\d{3,})/i);
    if (mapM) {
      const lat = parseFloat(mapM[1]);
      const lng = parseFloat(mapM[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) &&
          lat > 49 && lat < 55 && lng > 14 && lng < 24) {
        return { lat, lng };
      }
    }
    // 4. Plain "lat,lng" pair in Poland range (jsonldProduct.js-style
    //    fallback — catches patterns like "52.236, 21.042" anywhere on
    //    the page).
    const pairM = s.match(/\b(5[0-4]\.\d{4,}|49\.\d{4,})\s*,\s*(1[4-9]\.\d{4,}|2[0-4]\.\d{4,})\b/);
    if (pairM) {
      const lat = parseFloat(pairM[1]);
      const lng = parseFloat(pairM[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  }

  // Extract the full photo gallery from the detail page HTML. Tries (in
  // order):
  //   1. <a href="..." data-lightbox / data-gallery> — high-res URLs in
  //      anchor tags (typical Polish portal gallery pattern).
  //   2. <img src="..." data-large="..."> — visible thumbs with a
  //      data-large attribute pointing to the full-res version.
  //   3. <img src="https://..."> in any container that looks like a
  //      gallery (defensive — picks up thumbnails; dedupes by URL).
  //   4. Inline JS array of photo URLs (JSON-encoded strings).
  _extractPhotosFromHtml(html, { limit = 20 } = {}) {
    const s = String(html);
    const out = [];
    const seen = new Set();
    const push = (url) => {
      if (!url || typeof url !== 'string') return;
      const u = url.replace(/\\\//g, '/').trim();
      if (!u || !/^https?:\/\//.test(u)) return;
      // Skip common non-photo artifacts (logos, avatars, icons).
      if (/\/(logo|icon|avatar|placeholder|no-photo|no_person)\./i.test(u)) return;
      if (/\.(?:svg|gif|webp)$/i.test(u) && !/photo|gallery|upload/i.test(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
      if (out.length >= limit) return;
    };
    // 1. Anchor hrefs in a gallery / lightbox container
    const aRe = /<a[^>]+(?:data-(?:lightbox|gallery|large|full)|class="[^"]*(?:gallery|lightbox|photo|slider)[^"]*")[^>]+href="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    let m;
    while ((m = aRe.exec(s)) !== null) push(m[1]);
    // 2. <img> with data-large / data-full / data-src attribute
    const dRe = /<img[^>]+data-(?:large|full|src|original|href)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    while ((m = dRe.exec(s)) !== null) push(m[1]);
    // 3. <img src="https://..."> in a gallery-like container (defensive —
    //    catches all photos but may pick up a few thumbnails; dedup by URL)
    const imgRe = /<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    while ((m = imgRe.exec(s)) !== null) push(m[1]);
    return out;
  }

  // Extract the full Polish description from the detail page HTML. Tries:
  //   1. <div class="opis">…</div> or <div class="opis-oferty"> / <div
  //      class="description"> / <div id="description"> / <div class=
  //      "desc"> — common Polish portal description container names.
  //   2. <meta name="description" content="..."> — the SEO meta
  //      description (often a 1-line summary but sometimes the full text).
  //   3. <meta property="og:description" content="..."> — Facebook OG
  //      description (same content as #2 typically).
  _extractFullDescription(html) {
    const s = String(html);
    // 1. Visible "Opis" / "Opis oferty" / "description" div. Non-greedy
    //    match with a 8 KB cap so a missing close-tag doesn't scan to
    //    EOF. Tries multiple container names (opis / opis-oferty /
    //    description / desc / tresc). Matches either class or id attr.
    const divM = s.match(
      /<div[^>]*(?:class|id)\s*=\s*"[^"]*(?:opis(?:[-_]?oferty)?|description|desc|tresc|tekst)[^"]*"[^>]*>([\s\S]{0,8000}?)<\/div>/i
    );
    if (divM) {
      const d = stripTags(divM[1]);
      if (d && d.length > 80) return d;
    }
    // 2. <meta name="description" content="...">
    const metaM = s.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (metaM) {
      const d = stripTags(metaM[1]);
      if (d && d.length > 80) return d;
    }
    // 3. <meta property="og:description" content="...">
    const ogM = s.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogM) {
      const d = stripTags(ogM[1]);
      if (d && d.length > 80) return d;
    }
    return null;
  }

  // Infer conveniences from JSON-LD amenityFeature[] + additionalProperty[]
  // (when the JSON-LD block exposes them). Polish labels mirror the
  // convention used by adresowo/gratka/domiporta/tabelaofert.
  _inferConveniences(io, listing) {
    const conv = [];
    if (!io && !listing) return conv;
    const feats = io?.amenityFeature || listing?.amenityFeature || [];
    const props = io?.additionalProperty || listing?.additionalProperty || [];

    const hasAmenity = (name) => {
      for (const f of feats) {
        if (String(f?.name || '').toLowerCase().includes(name) &&
            (f.value === true || /^tak|istnieje|yes/i.test(String(f?.value || '')))) return true;
      }
      return false;
    };
    const getProp = (name) => {
      for (const p of props) {
        if (String(p?.name || '').toLowerCase().includes(name)) return p?.value;
      }
      return null;
    };

    if (hasAmenity('umeblowane') || hasAmenity('meble')) conv.push({ type: 'furniture', label: 'Umeblowane' });
    if (hasAmenity('balkon')) conv.push({ type: 'balcony', label: 'Balkon' });
    if (hasAmenity('taras')) conv.push({ type: 'balcony', label: 'Taras' });
    if (hasAmenity('garaz') || hasAmenity('garaż')) conv.push({ type: 'garage', label: 'Garaż' });
    if (hasAmenity('parking') || hasAmenity('miejsce parkingowe')) conv.push({ type: 'park', label: 'Parking' });
    if (hasAmenity('winda') || hasAmenity('wind')) conv.push({ type: 'lift', label: 'Winda' });
    if (hasAmenity('piwnica') || hasAmenity('komorka')) conv.push({ type: 'cellar', label: 'Piwnica' });
    if (hasAmenity('internet') || hasAmenity('wi-fi') || hasAmenity('wifi')) conv.push({ type: 'internet', label: 'Internet' });

    const liftProp = getProp('winda');
    if (liftProp && /tak|istnieje/i.test(String(liftProp))) {
      if (!conv.some(c => c.type === 'lift')) conv.push({ type: 'lift', label: 'Winda' });
    }
    const parkingProp = getProp('miejsce parkingowe');
    if (parkingProp && /tak/i.test(String(parkingProp))) {
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

  // Infer conveniences from the listing description text. Mirrors the
  // sprzedajemy.js _inferConveniences pattern — Polish keyword grep on
  // the description text. Used when the JSON-LD amenityFeature[] is
  // missing (the unverified bezposrednio.net.pl case).
  _inferConveniencesFromText(description) {
    const conv = [];
    const s = String(description || '').toLowerCase();
    if (!s) return conv;
    if (s.match(/\b(balkon|loggia|taras)\b/)) conv.push({ type: 'balcony', label: 'Balkon' });
    if (s.match(/\bgara[sz]\b/)) conv.push({ type: 'garage', label: 'Garaż' });
    if (s.match(/\bogr[oó]dek\b|\bogr[oó]d\b/)) conv.push({ type: 'garden', label: 'Ogródek' });
    if (s.match(/\b(parking|miejsce parkingowe|stanowisko)\b/)) conv.push({ type: 'park', label: 'Parking' });
    if (s.match(/\bwinda\b/)) conv.push({ type: 'lift', label: 'Winda' });
    if (s.match(/\bpiwnica|kom[oó]rka\b/)) conv.push({ type: 'cellar', label: 'Piwnica' });
    if (s.match(/\b(internet|wi-?fi)\b/)) conv.push({ type: 'internet', label: 'Internet' });
    if (s.match(/\b(umeblowane|z meblami|wyz|wypoza|meble)\b/)) conv.push({ type: 'furniture', label: 'Umeblowane' });
    if (s.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/)) {
      const mm = s.match(/\b(biedronka|lidl|[zs]abka|carrefour|auchan|kaufland|spar|lewiatan)\b/);
      if (mm) conv.push({ type: 'market', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    if (s.match(/\b(metro|tramwaj|autobus|stacja|przystanek)\b/)) {
      const mm = s.match(/\b(metro|tramwaj|autobus)\b/);
      if (mm) conv.push({ type: 'transport', label: `${mm[1].charAt(0).toUpperCase() + mm[1].slice(1)} nearby` });
    }
    return conv.slice(0, 8);
  }

  // Strip tracking/marketing query params so the same listing always produces
  // the same stored URL. Mirrors B5 (adresowo), B2-5 (otodom), B3-11 (olx),
  // D1 (nieruchomosci-online), D2 (domiporta), D3 (oferty-net), D5 (tabelaofert),
  // D-sprzedajemy-8 (sprzedajemy), D-wynajem24-11 (wynajem24).
  _normalizeUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    try {
      const u = new URL(rawUrl, this.baseUrl);
      const strip = /^(utm_|ref|ref_src|ref_url|fbclid|gclid|gbraid|wbraid|msclkid|mc_|_ga|yclid|ysclk|dclid|cmpid|source|medium|campaign|term|content|from)/i;
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
