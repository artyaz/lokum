// Nieruchomosci-online.pl scraper — Warsaw's largest rental portal
// (127k listings, JSON-LD on detail pages, NO Playwright needed).
//
// Site layout (verified 2026-08-30 via z-ai page_reader on live pages):
//
//   Search:  https://warszawa.nieruchomosci-online.pl/mieszkania,wynajem
//            pagination: ?p=2, ?p=3, ...
//            search JSON-LD: CollectionPage.mainEntity.offers[0].offers[]
//              (AggregateOffer → offers[] of Offer objects with url + image
//               + price + itemOffered{description,address,floorSize,numberOfRooms})
//
//   Detail:  https://warszawa.nieruchomosci-online.pl/mieszkanie,<slug>/<id>.html
//            detail JSON-LD: Apartment block with geo{lat,lng}, offers[0].price,
//              address{streetAddress,addressLocality,addressRegion},
//              numberOfRooms, floorLevel, floorSize, datePosted, image[] (3 only)
//
//   Photos:  inline JS `record.handleRecord({ ... photos: {x:[], l:[], c:[]} ... })`
//            the `l` (large) array gives 7-8+ full-res photo URLs per listing
//            (JSON-LD `image[]` only gives 3 — not enough for our 8-12 minimum)
//
//   Description: JSON-LD `description` is a short 1-line summary. The full
//            Polish text lives in HTML in a `<div class="estate-desc-more">`
//            block (hidden by default, but server-rendered). We strip tags
//            preserving <br> as newlines.
//
// Rate limiting (Task 3-b, measured live 2026-09-01):
//   The host enforces a rolling-window request quota. At 4 workers / 150 ms
//   gaps (~26 req/s) the first ~870 detail requests succeeded, then EVERY
//   request got `HTTP 429` with a Retry-After header that COUNTS DOWN from
//   ~3600 — i.e. a ~1 h hard block once the window quota (~900 requests /
//   ~6 min burst) is exhausted. Hitting it again during the block does NOT
//   extend it (countdown keeps decrementing), so the old behavior of
//   barreling through 300+ listings with 100% 429 failures achieved nothing.
//
// Fix (all requests to this host go through ONE module-wide gate):
//   - serialize: 1 in-flight request per host at a time (search pages,
//     _enrichNew and fetchOneListing/enrich.js backfill all share it)
//   - pace: >= 1.5 s between request starts (adaptive: doubles on 429 up
//     to 10 s, decays ~5% per clean request back toward the base)
//   - retry: on 429 HONOR the Retry-After header when present (the shared
//     base._fetch hides response headers, so detail/search fetches go
//     through scraper-local _rawFetch which surfaces status + Retry-After);
//     without the header, exponential 5→10→20 s backoff (env-tunable
//     NO_429_RETRY_DELAYS_MS for testing)
//   - give up smartly: Retry-After > 60 s (observed: countdown from ~3600 s
//     once the window quota is exhausted) arms the fail-fast cooldown —
//     zero requests until it lifts; if no header, 3 listings in a row that
//     exhausted 429 retries does the same, so the enrich.js backfill
//     workers stop feeding the block and the next backfill cycle finishes
//     the job once it lifts.
//   - ENRICH_LIMIT (300) is now actually honored: search walk (≤30 req) +
//     300 paced detail fetches stays inside the observed window quota.
//
// Task 3-b2 additions (live re-measured 2026-09-01, block still active at
// 12:11 with Retry-After 1065 s — header IS always present on 429 here):
//   - _rawFetch: scraper-local mirror of base._fetch (identical headers,
//     timeout, abort semantics) that attaches .status + .retryAfterMs to
//     the thrown error, letting _hostFetch honor Retry-After exactly.
//   - hard-block threshold: Retry-After > 60 s → arm _blockedUntil for
//     exactly that long (capped 70 min) instead of sleeping inline.
//   - streak-armed cooldown now EXTENDS an existing (longer) Retry-After
//     cooldown instead of overwriting it with the shorter 10 min default.
// Quality bar (per Task D brief):
//   - lat/lng: from JSON-LD Apartment.geo (must not be null)
//   - photos: 7-8+ URLs from `photos.l[]` inline JS
//   - description: full Polish text from `estate-desc-more` div
//   - price: PLN/monthly from JSON-LD Apartment.offers[0].price

import { BaseScraper } from './base.js';

const SOURCE_ID = 8;

// Search page yields ~30 listings per page. 30 pages × 30 = ~900 listings/city
// per fetch — well below the 127k Warsaw inventory, but enough to catch the
// newest ~0.7% each cron cycle. Pairs with the 3×/day schedule so each fetch
// catches everything added in the past ~8h with margin to spare.
const MAX_PAGES = 30;
const ENRICH_LIMIT = 300;
// Host gate serializes all requests module-wide, so a single worker is both
// sufficient and correct — extra workers would just pile up in the gate queue.
const ENRICH_CONCURRENCY = 1;
// Stop paginating after this many consecutive fetch failures — same pattern
// as gratka/olx (transient 5xx, network blip). 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// nieruchomosci-online.pl search results return ~30 listings per page.
const OFFERS_PER_PAGE = 30;

// ---- host rate-limit policy (see file header for measurements) ----
// Min spacing between request starts (adaptive interval starts here).
const FETCH_MIN_INTERVAL_MS = pageLimit('NO_FETCH_INTERVAL_MS', 1500);
// Ceiling for the adaptive interval after repeated 429s.
const FETCH_MAX_INTERVAL_MS = 10000;
// 429 retry backoff schedule (ms) — used ONLY when the response carries no
// Retry-After header (exponential 5→10→20 s). Env-tunable for tests.
const RETRY_DELAYS_MS = parseRetryDelays(process.env.NO_429_RETRY_DELAYS_MS);
// A Retry-After longer than this is a hard block (observed: countdown from
// ~3600 s once the window quota is exhausted) — fail fast, don't sleep.
const HARD_BLOCK_RETRY_AFTER_MS = pageLimit('NO_HARD_BLOCK_RA_MS', 60_000);
// Ceiling for a Retry-After-armed fail-fast cooldown (1 h block + margin).
const MAX_HARD_BLOCK_MS = 70 * 60_000;
// Consecutive listings that exhausted all 429 retries before we conclude
// we're hard-blocked and abort the walk.
const HARD_429_STREAK_LIMIT = 3;
// While hard-blocked, _hostFetch fails fast (no requests at all) for this long.
const BLOCK_COOLDOWN_MS = pageLimit('NO_BLOCK_COOLDOWN_MS', 10 * 60_000);

// City subdomain map (the site uses a per-city subdomain).
const CITY_SUBDOMAIN = {
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

function parseRetryDelays(raw) {
  const list = String(raw || '')
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n >= 0);
  return list.length ? list : [5_000, 10_000, 20_000];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// BaseScraper._fetch throws `HTTP 429 <statusText>` without exposing headers
// (shared file — off-limits), so 429 detection can only pattern-match the
// message. Shared-file note for the worklog: attaching `err.status` (and the
// Retry-After header) to that Error in base.js would let scrapers honor
// Retry-After precisely instead of using fixed backoffs.
function is429Error(e) {
  return /HTTP 429\b/.test(String(e?.message || ''));
}

// ---- module-wide host gate state ----
// Shared across ALL scraper instances and every code path (inline enrich walk,
// search pagination, enrich.js backfill workers, watcher) so no combination
// can stampede the host.
let _gateTail = Promise.resolve();
let _lastStartAt = 0;
let _curIntervalMs = FETCH_MIN_INTERVAL_MS;
let _blockedUntil = 0;

export class NieruchomosciOnlineScraper extends BaseScraper {
  // Streaming disabled — same reason as gratka: the enrichment step
  // (photos / full description / coords from the detail page) needs to
  // run AFTER the search walk, and the streaming `onListing` path skips
  // enrichment. We retain the listings array (~5 MB for 900 listings × 5 KB)
  // and then run the (rate-limited, serialized) detail fetch loop.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'nieruchomosci-online',
      baseUrl: 'https://www.nieruchomosci-online.pl'
    });
  }

  // The ONLY way this scraper talks to its host. Queues behind the module
  // gate (global serialization), waits for the adaptive min-interval, and
  // retries 429s — honoring Retry-After when present, else exponential
  // backoff — instead of failing immediately. Throws the original error
  // once retries are exhausted.
  async _hostFetch(url, opts = {}) {
    if (Date.now() < _blockedUntil) {
      const left = Math.ceil((_blockedUntil - Date.now()) / 1000);
      throw new Error(`HTTP 429 (nieruchomosci-online fail-fast: hard block detected, cooldown ${left}s left)`);
    }
    const run = async () => {
      // Pace: never start a request less than _curIntervalMs after the
      // previous one started (gate guarantees one run at a time, so this
      // check is race-free).
      const wait = _curIntervalMs - (Date.now() - _lastStartAt);
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        try {
          // Set before EVERY attempt (not just the first) so queued callers
          // pace off the last actual request start, including after backoffs.
          _lastStartAt = Date.now();
          const html = await this._rawFetch(url, opts);
          // Adaptive decay: with clean traffic, relax back toward the base
          // interval (429s may have pushed it up unnecessarily). ~0.95 per
          // request recovers 10s → 1.5s within ~40 clean requests.
          if (_curIntervalMs > FETCH_MIN_INTERVAL_MS) {
            _curIntervalMs = Math.max(FETCH_MIN_INTERVAL_MS, Math.round(_curIntervalMs * 0.95));
          }
          return html;
        } catch (e) {
          if (e?.status !== 429 && !is429Error(e)) throw e;
          // Long Retry-After = hard block (observed: countdown from ~3600 s
          // once the window quota is exhausted): arm the fail-fast cooldown
          // for exactly that long (capped) and give up immediately —
          // retrying into a sealed window only wastes wall time.
          if (e.retryAfterMs != null && e.retryAfterMs > HARD_BLOCK_RETRY_AFTER_MS) {
            _blockedUntil = Math.max(_blockedUntil, Date.now() + Math.min(e.retryAfterMs, MAX_HARD_BLOCK_MS));
            console.error(`[no] hard block (Retry-After ${Math.round(e.retryAfterMs / 1000)}s) — failing fast until ${new Date(_blockedUntil).toISOString()}`);
            throw e;
          }
          // Back off the whole host: next queued request waits longer
          // (exponential with a 5 s floor — the site punishes fast re-hits).
          _curIntervalMs = Math.min(FETCH_MAX_INTERVAL_MS, Math.max(_curIntervalMs * 2, pageLimit('NO_429_INTERVAL_FLOOR_MS', 5000)));
          if (attempt >= RETRY_DELAYS_MS.length) throw e;
          // Honor a short Retry-After exactly; else the exponential schedule.
          const backoff = e.retryAfterMs != null
            ? Math.max(1000, Math.min(e.retryAfterMs, HARD_BLOCK_RETRY_AFTER_MS))
            : RETRY_DELAYS_MS[attempt];
          console.warn(`[no] 429 on ${url} — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(backoff / 1000)}s${e.retryAfterMs != null ? ' (Retry-After)' : ''} (interval now ${_curIntervalMs}ms)`);
          await sleep(backoff);
        }
      }
    };
    const p = _gateTail.then(run, run);
    _gateTail = p.then(() => {}, () => {});
    return p;
  }

  // Scraper-local mirror of base._fetch — identical headers, timeout and
  // abort semantics — that, unlike the shared base method (whose !ok path
  // throws `HTTP <status> <statusText>` with no header access; editing
  // base.js is off-limits for platform tasks), attaches the HTTP status and
  // the Retry-After header (seconds-int or HTTP-date) to the thrown error
  // so _hostFetch can honor the site's rate-limit contract precisely.
  async _rawFetch(url, { timeout = 15000, desktop = false } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    const ua = desktop
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} ${r.statusText}`);
        e.status = r.status;
        const ra = r.headers.get('retry-after');
        if (ra) {
          const secs = Number.parseInt(String(ra).trim(), 10);
          if (Number.isFinite(secs)) e.retryAfterMs = secs * 1000;
          else {
            const d = Date.parse(String(ra));
            if (Number.isFinite(d)) e.retryAfterMs = Math.max(0, d - Date.now());
          }
        }
        throw e;
      }
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  async fetchCity(city, options = {}) {
    const sub = CITY_SUBDOMAIN[city.slug];
    if (!sub) return [];
    const { filters = {}, sinceTime = null } = options;

    const ads = [];
    const maxPages = pageLimit('NO_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (page > 1) params.set('p', String(page));
      // The site supports price filters via `ps[number]=X` query params on the
      // search URL, but we leave the filter to the runner's defensive pass —
      // the API surface here is HTML-only and the param names are easy to
      // mis-encode. (verified 2026-08-30: ?ps[price_from]=X works but is
      // brittle; runner-level filter is safer)
      const qs = params.toString();
      const url = `https://${sub}.nieruchomosci-online.pl/mieszkania,wynajem${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._hostFetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[no] fetch failed for ${city.slug} page ${page} (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[no] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0;

      const cards = this._parseSearchCards(html, city);
      if (!cards.length) {
        if (page === 1) console.warn(`[no] ${city.slug}: no listing URLs on page 1`);
        else console.log(`[no] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      for (const card of cards) {
        // Defensive runner-level filters also cover sources that can't
        // express every filter at URL level. We still pre-filter by price
        // here when the card carries a price (saves a detail-page fetch).
        if (filters.maxPrice != null && card.price && card.price > filters.maxPrice) continue;
        if (filters.minPrice != null && card.price && card.price < filters.minPrice) continue;

        const listing = {
          externalId: card.id,
          sourceId: SOURCE_ID,
          cityId: city.id,
          title: card.title || `Mieszkanie ${card.district || city.name_pl}`,
          description: card.description || '',
          price: card.price,
          currency: 'PLN',
          rooms: card.rooms || null,
          area: card.area || null,
          floor: card.floor || null,
          district: card.district || city.name_pl,
          street: card.street || null,
          address: card.address,
          lat: null,
          lng: null,
          url: card.url,
          postedAt: null,
          images: card.images || [],
          conveniences: [],
          raw: { url: card.url, searchCard: card.raw }
        };
        ads.push(listing);
      }
      console.log(`[no] ${city.slug} page ${page}: ${cards.length} cards (total ${ads.length})`);

      // sinceTime early-exit: the site's default sort is newest-first, so
      // once we've consumed an entire page without seeing any listing newer
      // than sinceTime, the next page can only contain older listings.
      // The search card doesn't carry a postedAt, so we can't do this here —
      // we'd need datePosted from the detail page. Skip the early-exit and
      // walk MAX_PAGES; the runner's persistListing + was_new detection
      // handles "new since previous run" correctly.
      if (cards.length < OFFERS_PER_PAGE) break;
    }

    if (ads.length) await this._enrichNew(ads, { sinceTime });
    return ads;
  }

  // Parse a search-results page. Returns an array of normalized "card"
  // objects with at least {id, url, title, price, rooms, area, district,
  // street, address, description, images, raw}. Most fields come from the
  // search JSON-LD (CollectionPage.mainEntity.offers[0].offers[]); the
  // description there is a 1-line summary — full text comes later from the
  // detail page (`_enrichNew` → `estate-desc-more` div).
  _parseSearchCards(html, city) {
    const out = [];
    const blocks = this._extractJsonLd(html);
    // Find the CollectionPage block with mainEntity.offers[] (an array of
    // AggregateOffer, each with .offers[] of Offer objects).
    let offers = null;
    for (const b of blocks) {
      if (b?.['@type'] === 'CollectionPage' && b?.mainEntity?.offers) {
        const o = b.mainEntity.offers;
        if (Array.isArray(o) && o.length && Array.isArray(o[0].offers)) {
          offers = o[0].offers;
          break;
        }
      }
    }
    if (offers) {
      for (const offer of offers) {
        const card = this._normalizeSearchOffer(offer, city);
        if (card) out.push(card);
      }
      return out;
    }
    // Fallback: regex-scan for listing detail URLs on the city subdomain.
    // Used if the JSON-LD block is missing or schema changes (CF shell etc.).
    const sub = CITY_SUBDOMAIN[city.slug] || 'warszawa';
    const simplerRe = new RegExp(
      `https://${sub}\\.nieruchomosci-online\\.pl/mieszkanie,[^"\\s<>]+/(\\d+)\\.html`,
      'gi'
    );
    const seen = new Set();
    const urls = [];
    let m;
    while ((m = simplerRe.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      urls.push({ id: m[1], url: m[0] });
    }
    for (const u of urls) {
      out.push({
        id: u.id,
        url: u.url,
        title: null,
        price: null,
        rooms: null,
        area: null,
        floor: null,
        district: city.name_pl,
        street: null,
        address: city.name_pl,
        description: '',
        images: [],
        raw: { url: u.url, via: 'regex-fallback' }
      });
    }
    return out;
  }

  // Map one JSON-LD Offer from the search results to a normalized card.
  _normalizeSearchOffer(offer, city) {
    const io = offer.itemOffered || {};
    const url = offer.url || io.url;
    if (!url) return null;
    const id = this._extractIdFromUrl(url);
    if (!id) return null;

    const price = offer.price != null ? Math.round(Number(offer.price)) : null;
    if (!price) return null;

    const addr = io.address || {};
    const street = addr.streetAddress || null;
    const district = addr.addressLocality || city.name_pl;

    const area = io.floorSize?.value != null
      ? Number(String(io.floorSize.value).replace(/[^\d.,]/g, '').replace(',', '.'))
      : null;
    const rooms = io.numberOfRooms != null ? parseInt(String(io.numberOfRooms), 10) || null : null;

    // Single thumbnail from the search JSON-LD — full gallery comes from
    // the detail page in `_enrichNew`.
    const images = offer.image ? [offer.image] : [];

    // Description is a partial 1-line summary in search JSON-LD; the full
    // Polish text is fetched from the detail page in `_enrichNew`.
    const description = io.description ? String(io.description) : '';

    return {
      id,
      url: this._normalizeUrl(url),
      title: offer.name ? String(offer.name).trim() : null,
      price,
      rooms,
      area,
      floor: null,
      district,
      street,
      address: [street, district].filter(Boolean).join(', ') || district,
      description,
      images,
      raw: {
        url,
        price,
        currency: offer.priceCurrency || 'PLN',
        rooms,
        area,
        street,
        district
      }
    };
  }

  // Extract the numeric listing id from a detail URL.
  //   https://warszawa.nieruchomosci-online.pl/mieszkanie,na-wynajem/26928915.html → "26928915"
  _extractIdFromUrl(url) {
    const m = String(url).match(/\/(\d{4,12})\.html?$/);
    return m ? m[1] : null;
  }

  // Enrich each listing with: full photos (7-8+), full Polish description,
  // lat/lng (from JSON-LD Apartment.geo), floorLevel, datePosted.
  //
  // Task 3-b rewrite: previously a 4-worker pool with 150 ms gaps fired
  // ~26 req/s, exhausted the host's rolling window after ~870 requests and
  // then burned the remaining listings with 100% HTTP 429 failures. Now:
  //   - single worker; every fetch goes through the module-wide host gate
  //     (>= 1.5 s spacing, adaptive on 429)
  //   - 429s are retried with backoff inside _hostFetch
  //   - HARD_429_STREAK_LIMIT consecutive listings that exhausted their
  //     retries abort the walk + trigger a fail-fast cooldown instead of
  //     hammering a hard block
  //   - ENRICH_LIMIT caps the batch per run so a walk stays inside the
  //     window quota; rows beyond the cap keep search-card data and are
  //     completed by the post-run enrichBackfill (enrich.js →
  //     fetchOneListing, which shares the same gate).
  //
  // The actual extraction is delegated to `_applyDetail` (shared with
  // `fetchOneListing` so the post-run enrichBackfill pipeline gets the
  // exact same per-field try/catch + extraction logic as the inline path).
  async _enrichNew(ads, { sinceTime = null } = {}) {
    if (!ads.length) return;
    const cap = pageLimit('NO_ENRICH_LIMIT', ENRICH_LIMIT);
    const batch = cap > 0 ? ads.slice(0, cap) : ads;
    let idx = 0;
    let hard429Streak = 0;
    let aborted = false;
    const self = this;
    console.log(`[no] enriching ${batch.length}/${ads.length} listings (photos/desc/coords, host pace >= ${_curIntervalMs}ms)`);
    async function worker() {
      while (idx < batch.length) {
        if (hard429Streak >= HARD_429_STREAK_LIMIT) { aborted = true; return; }
        const ad = batch[idx++];
        let html;
        try {
          html = await self._hostFetch(ad.url, { desktop: true, timeout: 20000 });
        } catch (e) {
          if (is429Error(e)) {
            hard429Streak++;
            console.warn(`[no] enrich: 429 (after retries) for ${ad.externalId} — hard-429 streak ${hard429Streak}/${HARD_429_STREAK_LIMIT}`);
            if (hard429Streak >= HARD_429_STREAK_LIMIT) {
              // Extend (never shorten) a Retry-After-armed cooldown that
              // _hostFetch may have already set for this same block.
              _blockedUntil = Math.max(_blockedUntil, Date.now() + BLOCK_COOLDOWN_MS);
              aborted = true;
              console.error(`[no] sustained 429 hard block — aborting enrich walk at ${idx}/${batch.length}; fail-fast until ${new Date(_blockedUntil).toISOString()}`);
            }
          } else {
            // single-listing fetch failure shouldn't fail the whole walk
            console.warn(`[no] enrich fetch failed for ${ad.externalId}: ${e.message}`);
          }
          continue;
        }
        hard429Streak = 0;
        try {
          self._applyDetail(html, ad);
        } catch (e) {
          // _applyDetail has internal per-field try/catch, but guard
          // against any unexpected throw so we don't crash the worker.
          console.warn(`[no] enrich: _applyDetail threw for ${ad.externalId}: ${e.message}`);
        }
        // Post-enrichment diagnostics (same shape as the fetchOneListing
        // path + the otodom/adresowo/morizon/domiporta fixes — Tasks
        // 4a/4b/4c/4d). Surfaces listings where extraction left gaps so
        // the run log shows which URLs to investigate. Previously these
        // gaps were invisible because the worker's outer catch only
        // logged on outright fetch/throw failures.
        const gaps = [];
        if (!ad.description || ad.description.length < 50) gaps.push(`desc=${ad.description?.length || 0}`);
        if (ad.lat == null || ad.lng == null) gaps.push('coords');
        if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
        if (gaps.length) {
          console.warn(`[no] enrichment gap for ${ad.externalId}: ${gaps.join(', ')}`);
        }
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    if (aborted) {
      console.warn(`[no] enrich walk aborted early — ${batch.length - idx} of ${batch.length} listings not attempted; enrich.js backfill will retry them after the block lifts`);
    }
  }

  // Apply detail-page data to an existing listing object. Extracts:
  //   - JSON-LD Apartment block → lat/lng (geo), floor (floorLevel),
  //     rooms (numberOfRooms), area (floorSize.value), street
  //     (address.streetAddress), district (address.addressLocality),
  //     postedAt (datePosted), price (offers[0].price fallback), title (name)
  //   - Full photos (7-8+) from `record.handleRecord` inline JS photos.l[]
  //   - Full Polish description from `<div class="estate-desc-more">`
  //   - Conveniences from amenityFeature[] + additionalProperty[]
  //
  // Per-field try/catch (Task 4e): each extraction block is wrapped in its
  // own try/catch with a logged warning. Previously the worker had all
  // extraction inline in a single try/catch — a single broken field (e.g.
  // a malformed geo block on an edge-case listing) would throw and abort
  // ALL subsequent extraction, leaving the listing with photos but no
  // coords/desc/etc. The extraction logic itself is unchanged — only the
  // error-handling shell was added.
  _applyDetail(html, ad) {
    if (!html) {
      console.warn(`[no] _applyDetail: empty html${ad?.url ? ` for ${ad.url}` : ''}`);
      return;
    }
    // 1. JSON-LD Apartment block — lat/lng, price, floor, area, datePosted
    let apt = null;
    try {
      apt = this._extractApartmentBlock(html);
    } catch (e) {
      console.warn(`[no] _applyDetail: apartment block extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
    }
    if (apt) {
      try {
        if (apt.geo?.latitude && apt.geo?.longitude) {
          const lat = parseFloat(apt.geo.latitude);
          const lng = parseFloat(apt.geo.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            ad.lat = lat;
            ad.lng = lng;
          }
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: coords extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      try {
        if (apt.floorLevel != null) {
          ad.floor = String(apt.floorLevel);
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: floor extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // numberOfRooms (more reliable than search JSON-LD's value)
      try {
        if (apt.numberOfRooms != null) {
          const r = parseInt(String(apt.numberOfRooms), 10);
          if (!isNaN(r)) ad.rooms = r;
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: rooms extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // floorSize
      try {
        if (apt.floorSize?.value != null) {
          const a = Number(String(apt.floorSize.value).replace(/[^\d.,]/g, '').replace(',', '.'));
          if (!isNaN(a)) ad.area = a;
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: area extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // address (more complete than search card)
      try {
        if (apt.address) {
          if (apt.address.streetAddress && !ad.street) {
            ad.street = String(apt.address.streetAddress);
          }
          if (apt.address.addressLocality) {
            ad.district = String(apt.address.addressLocality);
          }
          ad.address = [ad.street, ad.district].filter(Boolean).join(', ') || ad.district;
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: address extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // datePosted (ISO-ish — normalize later)
      try {
        if (apt.datePosted) {
          ad.postedAt = this._parsePostedAt(apt.datePosted);
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: postedAt extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // price (overwrite if search card missed it — Apartment block
      // has it inside offers[0].price)
      try {
        if (!ad.price && Array.isArray(apt.offers) && apt.offers[0]?.price) {
          ad.price = Math.round(Number(apt.offers[0].price));
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: price extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
      // title (fallback if search card missed it — Apartment.name)
      try {
        if (apt.name && !ad.title) {
          ad.title = String(apt.name).trim();
        }
      } catch (e) {
        console.warn(`[no] _applyDetail: title extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
      }
    }

    // 2. Full photos (7-8+) from the `record.handleRecord` inline JS
    try {
      const photos = this._extractPhotosFromJs(html);
      if (photos.length) ad.images = photos;
    } catch (e) {
      console.warn(`[no] _applyDetail: photos extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // 3. Full Polish description from `<div class="estate-desc-more">`
    // (the JSON-LD `description` is a 1-line summary; the real text
    // is in the desc-more div, hidden by default but server-rendered).
    try {
      const fullDesc = this._extractFullDescription(html);
      if (fullDesc && fullDesc.length > (ad.description || '').length) {
        ad.description = fullDesc;
      }
    } catch (e) {
      console.warn(`[no] _applyDetail: description extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // 4. Infer conveniences from the additionalProperty + amenityFeature
    try {
      if (!ad.conveniences || !ad.conveniences.length) {
        ad.conveniences = this._inferConveniences(apt, html);
      }
    } catch (e) {
      console.warn(`[no] _applyDetail: conveniences extraction failed${ad?.url ? ` for ${ad.url}` : ''}:`, e.message);
    }
  }

  // Per-listing detail-page fetcher used by the post-run enrichBackfill
  // pipeline (services/enrich.js) when a listing is missing coords /
  // description / photos. Mirrors the fetchOneListing contract on
  // otodom / adresowo / gratka / morizon / domiporta:
  //   - Returns null on fetch failure (caller keeps the existing stub).
  //   - Returns { externalId, sourceId, cityId, title, description, lat,
  //     lng, images, street, ... } with whatever fields it could extract
  //     from the detail page.
  //   - Per-field try/catch + post-enrichment gap diagnostics surface
  //     missing-data patterns in the run log instead of silently persisting
  //     incomplete listings (same pattern as Tasks 4a/4b/4c/4d).
  //
  // Task 3-b: routed through the module-wide host gate (_hostFetch) so the
  // enrich.js backfill's 3 concurrent workers (plus the watcher path and any
  // in-flight walk) all serialize into 1 request / >= 1.5 s instead of
  // stampeding the host into a ~1 h 429 block. During a detected hard block
  // the gate fails fast (throws 429-shaped error → we return null → enrich.js
  // skips the row until a later cycle).
  //
  // The heavy lifting is delegated to `_applyDetail` (shared with
  // `_enrichNew`) so the inline enrichment path and the post-run
  // enrichBackfill path both use the exact same extraction code.
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
      html = await this._hostFetch(url, { desktop: true, timeout: 20000 });
    } catch (e) {
      console.warn(`[no] fetchOneListing fetch failed for ${url}: ${e.message}`);
      return null;
    }
    // _applyDetail has internal per-field try/catch, but guard against any
    // unexpected throw so we still return a stub instead of crashing the
    // caller. Previously the BaseScraper default returned null — making
    // nieruchomosci-online enrichment a complete no-op (45% missing coords,
    // 7.7 avg photos pre-fix). With this override, the default-case path
    // in enrich.js now produces real data.
    try {
      this._applyDetail(html, ad);
    } catch (e) {
      console.warn(`[no] fetchOneListing: _applyDetail threw for ${url}: ${e.message}`);
    }
    // Post-enrichment diagnostics: surface listings where extraction left
    // gaps so the run log shows which URLs to investigate. Same shape as
    // the adresowo/otodom/morizon/domiporta fixes.
    const gaps = [];
    if (!ad.description || ad.description.length < 50) gaps.push(`desc=${ad.description?.length || 0}`);
    if (ad.lat == null || ad.lng == null) gaps.push('coords');
    if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
    if (gaps.length) {
      console.warn(`[no] enrichment gap for ${url}: ${gaps.join(', ')}`);
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

  // Find the JSON-LD block whose @type === "Apartment" on a detail page.
  _extractApartmentBlock(html) {
    const blocks = this._extractJsonLd(html);
    for (const b of blocks) {
      if (b?.['@type'] === 'Apartment') return b;
    }
    return null;
  }

  // Parse the `photos` object embedded in the inline JS:
  //   modules.record.handleRecord({ ... photos: { x:[], l:[], c:[] } ... })
  // `l` is the large-size URL array (typically 7-8+ entries).
  _extractPhotosFromJs(html) {
    const s = String(html);
    const idx = s.indexOf('photos:');
    if (idx === -1) return [];
    // Scan forward to find the opening brace of the photos object.
    const braceStart = s.indexOf('{', idx);
    if (braceStart === -1) return [];
    // Walk the JSON object respecting strings/escapes/braces.
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return [];
    let obj;
    try { obj = JSON.parse(s.slice(braceStart, end)); }
    catch { return []; }
    if (!obj || typeof obj !== 'object') return [];
    // Prefer the `l` (large) array — the same photos in higher resolution.
    // Fallback to `c` (categorized array of {url, alt}) then `x` (small thumbs).
    const pick = obj.l || (Array.isArray(obj.c) ? obj.c.map(c => c?.url).filter(Boolean) : obj.x);
    if (!Array.isArray(pick)) return [];
    const seen = new Set();
    const out = [];
    for (const u of pick) {
      if (typeof u !== 'string' || !u) continue;
      // normalize \/ escapes
      const url = u.replace(/\\\//g, '/');
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= 20) break; // persistListing cap
    }
    return out;
  }

  // Extract the full Polish description from the `<div class="estate-desc-more">`
  // block. The JSON-LD `description` field is a 1-line summary; the desc-more
  // div contains the entire agent-written text with <br> line breaks.
  _extractFullDescription(html) {
    const s = String(html);
    // The desc-more div is hidden by default (style="display: none;") but
    // server-rendered. We grab its inner HTML up to the matching </div>.
    // Strategy: find `class="estate-desc-more"`, then walk to the next
    // `</p>` (the desc-more block contains exactly one <p>...</p>).
    const m = s.match(/<div[^>]*class="estate-desc-more"[^>]*>([\s\S]*?)<\/div>/i);
    if (!m) return null;
    const inner = m[1];
    // Strip the <p class="body-md"> wrapper and trailing button
    const pMatch = inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const raw = pMatch ? pMatch[1] : inner;
    // Convert <br> to newlines, strip remaining tags, decode HTML entities.
    const text = raw
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || null;
  }

  // Parse the site's datePosted format: "2026-08-28CEST16:47:24Z" → ISO 8601.
  // The site embeds the CET/CEST timezone marker inside the ISO date —
  // invalid for Date.parse. Strip the tz marker, parse as UTC.
  _parsePostedAt(raw) {
    if (!raw) return null;
    const s = String(raw);
    // Strip "CEST" or "CET" markers between date and time.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:CEST|CET)?(\d{2}:\d{2}:\d{2})?Z?$/);
    if (m) {
      const iso = m[2] ? `${m[1]}T${m[2]}Z` : `${m[1]}T00:00:00Z`;
      const d = new Date(iso);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    // Fallback: try native Date.parse
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  // Infer conveniences from the JSON-LD amenityFeature[] + additionalProperty[]
  // (parking, balcony, garage, garden, lift, basement).
  _inferConveniences(apt, html) {
    const conv = [];
    if (!apt) return conv;
    const feats = apt.amenityFeature || [];
    const props = apt.additionalProperty || [];
    const has = (name) => {
      for (const f of feats) {
        if (String(f?.name || '').toLowerCase() === name && f.value === true) return true;
      }
      for (const p of props) {
        if (String(p?.name || '').toLowerCase() === name && /^tak/i.test(String(p?.value || ''))) return true;
      }
      return false;
    };
    if (has('parking')) conv.push({ type: 'park', label: 'Parking' });
    if (has('balcony')) conv.push({ type: 'balcony', label: 'Balkon' });
    if (has('garage')) conv.push({ type: 'garage', label: 'Garaż' });
    if (has('garden')) conv.push({ type: 'garden', label: 'Ogródek' });
    // Lift is not in amenityFeature — infer from additionalProperty
    // ("wind"/"winda" prop with value "Tak").
    const liftProp = props.find(p => /wind/i.test(String(p?.name || '')));
    if (liftProp && /^tak/i.test(String(liftProp.value || ''))) {
      conv.push({ type: 'lift', label: 'Winda' });
    }
    return conv.slice(0, 5);
  }

  // Strip tracking/marketing query params so the same listing always
  // produces the same stored URL (mirrors the olx pattern).
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
