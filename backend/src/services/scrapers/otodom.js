// Otodom scraper — parses __NEXT_DATA__ from search pages (plain fetch works
// with the /pl/oferty/ entry URL; CloudFront only blocks the old /pl/wynajem/ path).
// Search items lack coordinates + full description, so brand-new listings get
// a detail-page enrichment pass.
//
// Detail-page fetch strategy (Task 3-a, after DataDome started 403ing detail
// pages while the LIST feed kept working):
//   1. All detail fetches go through a process-wide PACER — serialized with a
//      min gap (~1.8s + jitter). The watcher enqueues bursts (e.g. "8 new" in
//      one tick) and _enrichNew ran 4 concurrent workers; that velocity is what
//      trips DataDome into a block window where EVERY detail fetch 403s.
//   2. Requests carry full Chrome client hints (sec-ch-ua, sec-fetch-*,
//      Upgrade-Insecure-Requests) + a search-page Referer — plain UA-only
//      headers score as a bot.
//   3. On 403/429 (or a 200 challenge page without __NEXT_DATA__): one
//      backoff-and-retry, then fall back to the stealth headless browser
//      (fetchRendered). Hard failure → caller logs ONE line and the runner
//      keeps the stub.

import { BaseScraper } from './base.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 2;
const MAX_PAGES = 30;         // covers ~1080 listings (≈15% of Warsaw rent feed)
                              // — enough for daily cron + busy days. Override via
                              // OTODOM_MAX_PAGES env if needed.
const ENRICH_LIMIT = 200;      // detail-page fetches per city per run
const ENRICH_CONCURRENCY = 4;

// Task 3-a: DataDome rate window. Detail fetches are serialized process-wide
// with this min gap (+ jitter) so watcher bursts / enrich workers can never
// exceed ~25 detail requests/min. Spacing requests 1.8-2.4s apart kept every
// fetch at HTTP 200 in testing, while 4-way concurrent bursts during the
// watcher's "N new" enqueues preceded every 403 streak in the logs.
const DETAIL_MIN_GAP_MS = 1800;
const DETAIL_403_RETRY_DELAY_MS = 12000;

// Serialized promise-chain pacer shared by fetchOneListing (watcher) and
// _enrichNew (cron) so both paths share one throttle. Each caller awaits its
// turn; the chain survives individual rejections.
let _detailChain = Promise.resolve();
let _lastDetailAt = 0;
function _paceDetail() {
  const run = _detailChain.then(async () => {
    const wait = _lastDetailAt + DETAIL_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait + Math.random() * 600));
    _lastDetailAt = Date.now();
  });
  _detailChain = run.catch(() => {});
  return run;
}

// Otodom occasionally emits sentinel listings with a placeholder dateCreated
// of "1999-02-29 00:00:01" (partner-fed reposts that lack a real timestamp).
// These break our "newest first" sort and waste a slot — skip them.
const SENTINEL_DATE_RE = /^1999-/;

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

const ROOMS_ENUM = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
  SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10
};

const FLOOR_ENUM = {
  CELLAR: 'basement', GROUND: '0', FIRST: '1', SECOND: '2', THIRD: '3',
  FOURTH: '4', FIFTH: '5', SIXTH: '6', SEVENTH: '7', EIGHTH: '8', NINTH: '9',
  TENTH: '10', HIGHER_THAN_TENTH: '10+', GARRET: 'attic'
};

// "2026-07-21 23:49:59" (Europe/Warsaw local) → Date
function warsawDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) { const d = new Date(str); return isNaN(d) ? null : d; }
  const [, y, mo, d, h, mi, s] = m;
  // Determine Warsaw UTC offset for that date (CET=+1, CEST=+2)
  const approx = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
  const month = +mo;
  const offsetHours = (month >= 4 && month <= 9) ? 2 : 1; // good enough for listings
  return new Date(approx.getTime() - offsetHours * 3600_000);
}

export class OtodomScraper extends BaseScraper {
  supportsStreaming = true;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'otodom', baseUrl: 'https://www.otodom.pl' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, sinceTime = null, onListing = null } = options;

    const ads = [];
    const maxPages = pageLimit('OTODOM_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      params.set('sorting', 'latest');
      if (filters.maxPrice != null) params.set('priceMax', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('priceMin', String(filters.minPrice));
      if (page > 1) params.set('page', String(page));
      const url = `${this.baseUrl}/pl/oferty/wynajem/mieszkanie/${cityPath}?${params.toString()}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true });
        consecutiveFailures = 0;
      } catch (e) {
        console.warn(`[otodom] plain fetch failed (${e.message}), trying browser…`);
        try {
          // waitMs defaults to 1500ms in browser.js (Task A2). That is enough
          // for the Next.js __NEXT_DATA__ script to land on domcontentloaded.
          html = await fetchRendered(url);
          consecutiveFailures = 0;
        } catch (e2) {
          consecutiveFailures++;
          console.error(`[otodom] browser fetch failed (${e2.message}); ${consecutiveFailures} consecutive failure(s)`);
          // Cloudflare blocks are often transient. Skip this page and keep
          // walking; only bail out after 3 consecutive failures (likely a
          // hard IP block that won't recover mid-run).
          if (consecutiveFailures >= 3) {
            console.error(`[otodom] ${city.slug} ${consecutiveFailures} consecutive page failures, aborting walk`);
            break;
          }
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }

      const items = this._extractItems(html);
      if (!items) {
        console.warn(`[otodom] ${city.slug} page ${page}: no __NEXT_DATA__/items, stopping`);
        break;
      }
      if (!items.length) break;

      // Walk this page's items newest-first. Otodom's "latest" sort is
      // polluted by promoted/partner listings (some carry a sentinel 1999
      // date), so we can't break on the FIRST old item. Instead we count
      // how many items on the page are newer than sinceTime; if NONE are,
      // the next page can only be older still — safe to stop there.
      let inWindow = 0;
      let processedOnPage = 0;
      for (const ad of items) {
        try {
          const l = this._normalize(ad, city);
          if (!l) continue;
          processedOnPage++;
          if (sinceTime && l.postedAt && new Date(l.postedAt) >= sinceTime) inWindow++;
          if (onListing) await onListing(l);
          else ads.push(l);
        } catch (e) {
          // Per-item normalize failure — one malformed ad shouldn't kill the
          // page walk, but log the externalId (if recoverable) so patterns
          // of bad upstream data are visible.
          console.warn(`[otodom] ${city.slug} page ${page}: _normalize threw for ad ${ad?.id || '?'}:`, e.message);
        }
      }
      console.log(`[otodom] ${city.slug} page ${page}: ${processedOnPage} ads (total ${ads.length}${sinceTime ? `, ${inWindow} newer than sinceTime` : ''})`);

      // Early-termination: nothing on this page is newer than sinceTime → stop.
      if (sinceTime && processedOnPage > 0 && inWindow === 0) {
        console.log(`[otodom] ${city.slug} page ${page}: no in-window items, stopping early`);
        break;
      }

      const totalPages = this._totalPages(html);
      if (totalPages && page >= totalPages) break;
    }

    // Enrich brand-new listings (not yet in DB) with detail-page data
    // In streaming mode the runner persists first; the bounded post-run
    // enricher can then target only listings that are actually missing data.
    if (!onListing) await this._enrichNew(ads);

    return onListing ? [] : ads;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // Loads page 1 of the Otodom search results on the source's persistent
  // BrowserContext (cookies + localStorage from .playwright-state/otodom.json
  // — reuses Datadome clearance so CloudFront sees a returning visitor),
  // parses __NEXT_DATA__'s searchAds.items, and returns
  // `[{ externalId, postedAt, url, cityId }]` ordered newest-first.
  //
  // No detail-page enrichment, no full normalize — the watcher only needs
  // the IDs for hash-based change detection (H2-T3) and the last-seen-ID
  // watermark short-circuit (H2-T4).
  //
  // `page` MUST be a Playwright Page from the otodom persistent context.
  // Falls through to plain `this._fetch` if `page` is null (e.g. watcher
  // couldn't acquire a context — degraded but still functional).
  async watchLatest(page, cities) {
    const out = [];
    for (const city of cities) {
      const cityPath = CITY_PATH[city.slug];
      if (!cityPath) continue;
      const params = new URLSearchParams();
      params.set('sorting', 'latest');
      const url = `${this.baseUrl}/pl/oferty/wynajem/mieszkanie/${cityPath}?${params.toString()}`;
      let html;
      try {
        if (page) {
          // page.goto on the persistent context — warm TLS, reused cookies.
          // `waitUntil: 'domcontentloaded'` is enough for __NEXT_DATA__ to
          // land (the SSR shell serves it inline, no client-side fetch).
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (!resp || resp.status() >= 400) {
            throw new Error(`HTTP ${resp ? resp.status() : 'no-response'}`);
          }
          // brief settle for Next.js hydration
          await page.waitForTimeout(500);
          html = await page.content();
        } else {
          html = await this._fetch(url, { desktop: true });
        }
      } catch (e) {
        console.warn(`[otodom] watcher fetch failed for ${city.slug}:`, e.message);
        continue;
      }
      const items = this._extractItems(html);
      if (!items) continue;
      for (const ad of items) {
        if (!ad?.id || !ad?.slug) continue;
        const dateCreated = ad.dateCreated || '';
        if (SENTINEL_DATE_RE.test(dateCreated)) continue; // skip 1999 partner posts
        out.push({
          externalId: String(ad.id),
          postedAt: warsawDate(dateCreated),
          url: this._normalizeUrl(`${this.baseUrl}/pl/oferta/${ad.slug}`),
          cityId: city.id
        });
      }
    }
    return out;
  }

  // Per-listing detail fetch (Task I — H4 design). Called by
  // `enqueueNewListing` in runner.js when the watcher detects a new
  // externalId. Fetches the detail page HTML and runs `_applyDetail` to
  // populate description / coords / postedAt / images / params on a stub
  // listing object. Price/rooms/area/floor are NOT recoverable from the
  // detail page alone (those live in the search-result __NEXT_DATA__);
  // those fields are left null and the next full-cron run will UPSERT
  // the full data.
  //
  // Returns null on any failure — `enqueueNewListing` falls through to
  // persisting just the stub.
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    const ad = {
      id: externalId,
      slug: url.includes('/pl/oferta/') ? url.split('/pl/oferta/')[1].split('?')[0] : '',
      url,
      images: [],
      raw: { params: [] }
    };
    let html;
    try {
      html = await this._fetchDetail(url, { city });
    } catch (e) {
      // ONE clear line per hard failure (runner falls back to the stub).
      console.warn(`[otodom] detail fetch failed for ${url}: ${e.message}`);
      return null;
    }
    // _applyDetail has internal per-field try/catch, but guard against any
    // unexpected throw so we still return a stub instead of crashing the
    // caller. Previously this was `try { ... } catch {}` which silently
    // swallowed ALL errors — making it impossible to diagnose why so many
    // otodom listings ended up with empty description / null coords.
    try {
      this._applyDetail(html, ad);
    } catch (e) {
      console.warn(`[otodom] fetchOneListing: _applyDetail threw for ${url}:`, e.message);
    }
    // Surface incomplete enrichment so missing-data patterns are visible
    // in the run log. If a large fraction of listings come back missing
    // the same field, that's a signal the detail-page structure changed
    // and the extraction needs updating — previously these gaps were
    // invisible because the outer catch swallowed everything.
    const gaps = [];
    if (!ad.description) gaps.push('no-description');
    if (ad.lat == null || ad.lng == null) gaps.push('no-coords');
    if (!ad.images.length) gaps.push('no-images');
    if (gaps.length) {
      console.warn(`[otodom] fetchOneListing incomplete for ${url}: ${gaps.join(', ')}`);
    }
    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: ad.title || 'Pending enrichment',
      description: ad.description || '',
      price: 0,
      currency: 'PLN',
      rooms: null,
      area: null,
      floor: null,
      district: ad.district || city.name_pl,
      street: ad.street || null,
      address: ad.address || null,
      lat: ad.lat || null,
      lng: ad.lng || null,
      url,
      postedAt: ad.postedAt || null,
      images: ad.images || [],
      conveniences: [],
      raw: ad.raw || {}
    };
  }

  // Detail-page HTML fetch with full Chrome client hints + a search-page
  // Referer, a 403 backoff-retry, and a stealth-browser last resort. Shared by
  // fetchOneListing (watcher path) and _enrichNew (cron path) so both get the
  // same pacing + fallback behavior.
  async _fetchDetail(url, { city = null } = {}) {
    const cityPath = city && CITY_PATH[city.slug] ? CITY_PATH[city.slug] : '';
    const referer = `${this.baseUrl}/pl/oferty/wynajem/mieszkanie/${cityPath}`;
    let lastErr = null;
    // Attempt 1+2: paced browser-like fetch. Only block-style failures retry;
    // anything else (DNS, abort, 404) throws to the caller immediately.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await _paceDetail();
      try {
        const html = await this._fetchBrowserLike(url, { referer });
        if (!/__NEXT_DATA__/i.test(html)) {
          throw new Error('HTTP 200 but no __NEXT_DATA__ (bot challenge page)');
        }
        return html;
      } catch (e) {
        lastErr = e;
        const blocked = /HTTP 40[34]|HTTP 429|bot challenge/i.test(e.message);
        if (!blocked) throw e;
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, DETAIL_403_RETRY_DELAY_MS + Math.random() * 4000));
        }
      }
    }
    // Last resort: stealth headless Chromium (fresh context, real TLS/H2
    // fingerprint). If even this gets challenged it returns a captcha page —
    // surface that in the error so the caller's single log line explains it.
    try {
      const html = await fetchRendered(url, { waitMs: 1500, timeout: 20000 });
      if (!/__NEXT_DATA__/i.test(html)) {
        throw new Error(`challenge page after retry+browser (${lastErr ? lastErr.message : 'no data'})`);
      }
      return html;
    } catch (e) {
      throw new Error(`${lastErr ? lastErr.message : 'detail fetch failed'}; browser fallback failed: ${e.message}`);
    }
  }

  // Plain fetch with a full Chrome 126 header set (client hints, sec-fetch-*,
  // Referer). DataDome scores the bare UA+Accept header set of base._fetch as
  // a bot; a coherent browser header set passes on its own when request
  // velocity is paced (see _paceDetail).
  async _fetchBrowserLike(url, { referer = null, timeout = 15000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'sec-ch-ua': '"Not/A)Brand";v="4", "Chromium";v="126", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': referer ? 'same-origin' : 'none',
      'sec-fetch-user': '?1',
      'Upgrade-Insecure-Requests': '1'
    };
    if (referer) headers['Referer'] = referer;
    try {
      const r = await fetch(url, { headers, signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  _extractItems(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch { return null; }
    return data?.props?.pageProps?.data?.searchAds?.items ?? null;
  }

  _totalPages(html) {
    const m = html.match(/"totalPages"\s*:\s*(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  _normalize(ad, city) {
    if (!ad?.id || !ad?.slug) return null;
    const price = ad.totalPrice?.value;
    if (!price) return null;

    // Skip partner-fed sentinel listings whose dateCreated is the placeholder
    // "1999-02-29 00:00:01" — they pollute the "latest" sort, have a synthetic
    // long id (e.g. 96829782300067), and confuse the runner's "new" detection.
    const dateCreated = ad.dateCreated || '';
    if (SENTINEL_DATE_RE.test(dateCreated)) return null;

    // Build a clean, normalized listing URL (no tracking params). The scraper
    // only ever emits /pl/oferta/<slug>, but we normalize defensively in case
    // the upstream `ad.href` or `ad.url` field is ever used as a fallback.
    const url = this._normalizeUrl(`${this.baseUrl}/pl/oferta/${ad.slug}`);

    // district from reverseGeocoding
    let district = null;
    const rg = ad.location?.reverseGeocoding?.locations || [];
    const dLoc = rg.find(x => x.locationLevel === 'district');
    if (dLoc) district = dLoc.name;

    const street = ad.location?.address?.street?.name || null;

    const images = (ad.images || [])
      .map(im => im?.large || im?.medium)
      .filter(Boolean);

    const params = [];
    if (ad.rentPrice?.value) params.push({ key: 'rent', name: 'Czynsz (dodatkowo)', value: `${ad.rentPrice.value} zł` });
    if (ad.roomsNumber) params.push({ key: 'rooms', name: 'Liczba pokoi', value: String(ROOMS_ENUM[ad.roomsNumber] || ad.roomsNumber) });
    if (ad.areaInSquareMeters) params.push({ key: 'm', name: 'Powierzchnia', value: `${ad.areaInSquareMeters} m²` });
    params.push({ key: 'advertiser_type', name: 'Typ ogłoszeniodawcy', value: ad.isPrivateOwner ? 'Osobiste' : 'Firmowe' });

    return {
      externalId: String(ad.id),
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: String(ad.title || '').trim(),
      description: '',
      price: Math.round(price),
      currency: 'PLN',
      rooms: ROOMS_ENUM[ad.roomsNumber] || null,
      area: ad.areaInSquareMeters || null,
      floor: FLOOR_ENUM[ad.floorNumber] || null,
      district: district || city.name_pl,
      street,
      address: [street, district || city.name_pl].filter(Boolean).join(', '),
      lat: null,
      lng: null,
      url,
      postedAt: warsawDate(dateCreated),
      images,
      conveniences: [],
      raw: {
        id: ad.id,
        slug: ad.slug,
        title: ad.title,
        totalPrice: ad.totalPrice,
        rentPrice: ad.rentPrice,
        roomsNumber: ad.roomsNumber,
        areaInSquareMeters: ad.areaInSquareMeters,
        floorNumber: ad.floorNumber,
        isPrivateOwner: ad.isPrivateOwner,
        agency: ad.agency?.name || null,
        dateCreated,
        params
      }
    };
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Otodom URLs as constructed by the scraper are already
  // clean, but normalizing defensively protects against future regressions
  // and against imported URLs with utm_*/gclid/fbclid etc.
  _normalizeUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    try {
      const u = new URL(rawUrl, this.baseUrl);
      const strip = /^(utm_|ref|ref_src|ref_url|fbclid|gclid|gbraid|wbraid|msclkid|mc_|_ga|yclid|ysclk|dclid|cmpid|source|medium|campaign|term|content)/i;
      for (const k of [...u.searchParams.keys()]) {
        if (strip.test(k)) u.searchParams.delete(k);
      }
      // Re-emit without trailing '?' or '&'
      const search = u.searchParams.toString();
      return `${u.origin}${u.pathname}${search ? '?' + search : ''}`;
    } catch {
      return rawUrl;
    }
  }

  // Detail-page enrichment for new listings AND those missing coords/images.
  async _enrichNew(ads) {
    if (!ads.length) return;
    const ids = ads.map(a => a.externalId);
    let knownWithData = new Set();
    try {
      const rows = await many(
        `SELECT l.external_id FROM listings l
         WHERE l.source_id = $1 AND l.external_id = ANY($2::text[])
           AND l.lat IS NOT NULL
           AND (SELECT count(*) FROM listing_images li WHERE li.listing_id = l.id) >= 3`,
        [SOURCE_ID, ids]
      );
      knownWithData = new Set(rows.map(r => r.external_id));
    } catch (e) {
      console.warn('[otodom] known-id lookup failed:', e.message);
    }
    const fresh = ads.filter(a => !knownWithData.has(a.externalId)).slice(0, ENRICH_LIMIT);
    if (!fresh.length) return;
    console.log(`[otodom] enriching ${fresh.length} listings with detail pages`);

    let idx = 0;
    async function worker(scraper) {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          // Task 3-a: _fetchDetail (paced + retry + browser fallback) instead
          // of raw _fetch — the bare-header unpaced path is what DataDome was
          // 403ing.
          const html = await scraper._fetchDetail(ad.url);
          scraper._applyDetail(html, ad);
        } catch (e) {
          // detail fetch is best-effort: ONE line per hard failure so 403
          // streaks stay visible without flooding the log
          console.warn(`[otodom] _enrichNew detail fetch failed for ${ad.url}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker(this));
    await Promise.all(workers);
  }

  // Parse the otodom detail page's __NEXT_DATA__ and fill `ad` with
  // description / coords / postedAt / images / params. Each field is
  // extracted in its own try/catch so a single malformed field doesn't
  // kill the whole enrichment pass — previously a thrown error in any
  // branch was silently swallowed by the caller's `try { _applyDetail() } catch {}`,
  // which made missing-data debugging nearly impossible.
  _applyDetail(html, ad) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) {
      console.warn(`[otodom] _applyDetail: no __NEXT_DATA__ script in HTML${ad.url ? ` for ${ad.url}` : ''}`);
      return;
    }
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch (e) {
      console.warn(`[otodom] _applyDetail: __NEXT_DATA__ JSON parse failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
      return;
    }
    // Standard otodom detail page exposes the ad under props.pageProps.ad.
    // Fall back to props.pageProps.listing defensively (older variants).
    const d = data?.props?.pageProps?.ad || data?.props?.pageProps?.listing;
    if (!d) {
      const ppKeys = Object.keys(data?.props?.pageProps || {});
      console.warn(`[otodom] _applyDetail: no props.pageProps.ad${ad.url ? ` for ${ad.url}` : ''} (pageProps keys: [${ppKeys.join(', ')}])`);
      return;
    }

    // Coordinates
    try {
      if (d.location?.coordinates) {
        ad.lat = d.location.coordinates.latitude ?? null;
        ad.lng = d.location.coordinates.longitude ?? null;
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: coords extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // Description — strip HTML tags AND decode common entities (otodom
    // returns a raw HTML string with &nbsp;/&amp;/&quot; etc.). Without
    // entity decoding the description is littered with "&nbsp;" tokens.
    try {
      if (d.description) {
        ad.description = String(d.description)
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;|&apos;/g, "'")
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: description extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // Title — not previously extracted. The watcher stub path sets
    // title='Pending enrichment'; pulling d.title here lets fetchOneListing
    // return the real headline instead of the placeholder.
    try {
      if (d.title) ad.title = String(d.title).trim();
    } catch (e) {
      console.warn(`[otodom] _applyDetail: title extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // PostedAt
    try {
      if (d.createdAt) {
        const dt = new Date(d.createdAt);
        if (!isNaN(dt)) ad.postedAt = dt;
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: postedAt extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // Street — improves address quality for watcher-inserted stubs
    try {
      const streetName = d.location?.address?.street?.name;
      if (streetName) ad.street = streetName;
    } catch (e) {
      console.warn(`[otodom] _applyDetail: street extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // District — from reverseGeocoding (mirrors _normalize). Only set when
    // ad.district is empty so we don't clobber a value already provided by
    // the search-page _normalize path.
    try {
      if (!ad.district) {
        const rg = d.location?.reverseGeocoding?.locations || [];
        const dLoc = rg.find(x => x.locationLevel === 'district');
        if (dLoc) ad.district = dLoc.name;
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: district extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // characteristics → params (czynsz, deposit, availability...)
    try {
      const chars = Array.isArray(d.characteristics) ? d.characteristics : [];
      const extraParams = [];
      for (const c of chars) {
        if (!c?.key && !c?.label) continue;
        const label = c.label || c.localizedLabel || c.key;
        const value = c.value ?? c.localizedValue ?? '';
        if (label && value !== '') extraParams.push({ key: c.key || label, name: label, value: String(value) });
        // rent price → bump raw
        if (c.key === 'rent' && c.value && !ad.raw.rentPrice) {
          const n = parseInt(String(c.value).replace(/[^\d]/g, ''));
          if (n) ad.raw.rentPrice = { value: n, currency: 'PLN' };
        }
      }
      if (extraParams.length) {
        ad.raw.params = [...(ad.raw.params || []), ...extraParams];
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: characteristics extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }

    // Images — detail page has the FULL gallery (typically 8-12 photos).
    // Search page only exposes 1-3 thumbnails. In fetchOneListing `ad.images`
    // starts as `[]`, so any non-empty detail-page gallery replaces it.
    // In _enrichNew (non-streaming path) `ad.images` already holds the
    // search-page thumbnails; we only overwrite when the detail page has
    // MORE photos (don't downgrade a richer search-page set, which would
    // be unusual but defensive). Falls back to `medium` then `thumbnail`
    // for listings whose `large` variant is missing.
    try {
      if (Array.isArray(d.images) && d.images.length) {
        const imgs = d.images
          .map(im => im?.large || im?.medium || im?.thumbnail)
          .filter(Boolean);
        if (imgs.length > ad.images.length) ad.images = imgs;
      }
    } catch (e) {
      console.warn(`[otodom] _applyDetail: images extraction failed${ad.url ? ` for ${ad.url}` : ''}:`, e.message);
    }
  }
}

