// OLX scraper — uses OLX public REST API v1 (https://www.olx.pl/api/v1/offers).
//
// The OLX search-results HTML page embeds this same API URL inside its
// `__PRERENDERED_STATE__.listing.listing.links.first` field, so the API is
// the canonical "real" OLX search backend — the HTML page is just a
// server-rendered shell around it. Going through the API instead of scraping
// the HTML is much more reliable:
//
//   - clean JSON, no need for the JS-string-literal codec dance (the old
//     `codecsDecodeJsString()` import is removed)
//   - returns the FULL description + map coords + photo URLs on every item
//     (the old HTML path only returned 13 ads/page and required detail-page
//     enrichment for coords)
//   - honors filter_float_price:to / filter_enum_rooms as direct query params
//     (NOT as the `search[...]` array syntax the HTML form builder uses)
//   - OLX caps `metadata.total_elements` at 1000 per request — the real
//     visible count is in `metadata.visible_total_count` (Warsaw: ~6 144,
//     Kraków: ~3 718). To exceed the cap we'd need to subdivide by district
//     or price range; for now, walking the full cap gives 1 000 listings
//     per city per fetch — a 7–8× improvement over the old MAX_PAGES=10 path
//     which only fetched ~130 listings.
//
// OLX's `created_at:desc` sort is polluted by promoted ads (they get bumped
// to the top of every page regardless of their real created_time). The
// promoted listings repeat across pages; their stable `id` means the
// `(source_id, external_id)` upsert in persistListing dedupes them naturally
// across pages. We can therefore stop early ONLY when NOTHING on a page
// (promoted or organic) is newer than sinceTime.

import { BaseScraper } from './base.js';

const SOURCE_ID = 1;

// OLX API caps `limit` at 50. With 50 organic items + ~10 promoted per page,
// walking the 1000-item hard cap takes 20 fetches (≈30 s with 1.5 s sleeps).
const PAGE_LIMIT = 50;

// Walking 20 pages yields ~1000 listings (the OLX API cap). Override via
// `OLX_MAX_PAGES` env if a shorter walk is needed.
const MAX_PAGES = 20;

// OLX city/region IDs (discovered 2026-08-29 by walking each city's HTML
// path and reading the embedded __PRERENDERED_STATE__ metadata; these are
// stable OLX-internal IDs that don't change). category_id=15 is
// "nieruchomosci/mieszkania/wynajem" (apartment rent) globally.
const CATEGORY_ID = 15;

const CITY_INFO = {
  warsaw:  { path: 'warszawa', cityId: 17871, regionId: 2 },
  krakow:  { path: 'krakow',  cityId: 8959,  regionId: 4 },
  wroclaw: { path: 'wroclaw', cityId: 19701, regionId: 3 },
  gdansk:  { path: 'gdansk',  cityId: 5659,  regionId: 5 },
  poznan:  { path: 'poznan',  cityId: 13983, regionId: 1 }
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// OLX room enum: only 4 buckets — 'one' (studio / Kawalerka), 'two', 'three',
// and 'four' (which OLX labels "4 i więcej" = 4+ rooms). Listings with 5+
// rooms are folded into 'four'. There is no 'five'/'six'/'seven'/'eight'
// enum value on OLX, so we cannot distinguish them. The runner's
// minRooms/maxRooms filters see at most `rooms=4` for any OLX listing.
const ROOM_ENUM = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four'
};
const ROOM_NUMBER = Object.fromEntries(
  Object.entries(ROOM_ENUM).map(([n, slug]) => [slug, Number(n)])
);

export class OlxScraper extends BaseScraper {
  supportsStreaming = true;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'olx', baseUrl: 'https://www.olx.pl' });
  }

  /**
   * @param {Object} city - city row { id, name, name_pl, slug, lat, lng }
   * @param {Object} options
   * @param {Object} [options.filters] - { maxPrice, minPrice, minRooms, maxRooms }
   * @param {Date}   [options.sinceTime] - only consider listings created after this
   * @param {Function} [options.onListing] - streaming callback
   * @returns {Promise<Array>} normalized listings (caller filters by sinceTime)
   */
  async fetchCity(city, options = {}) {
    const info = CITY_INFO[city.slug];
    if (!info) return [];
    const { filters = {}, sinceTime = null, onListing = null } = options;

    const allAds = [];
    let emptyPage = false;
    let seen = 0;
    let consecutiveFailures = 0;
    const emit = async (listing) => {
      if (!listing) return;
      seen++;
      if (onListing) await onListing(listing);
      else allAds.push(listing);
    };

    const maxPages = pageLimit('OLX_MAX_PAGES', MAX_PAGES);
    let totalElements = null;

    for (let page = 0; page < maxPages && !emptyPage; page++) {
      const offset = page * PAGE_LIMIT;
      const params = new URLSearchParams();
      params.set('offset', String(offset));
      params.set('limit', String(PAGE_LIMIT));
      params.set('category_id', String(CATEGORY_ID));
      params.set('region_id', String(info.regionId));
      params.set('city_id', String(info.cityId));
      params.set('sort_by', 'created_at:desc');
      // OLX API filter params are direct query params (NOT the `search[...]`
      // array syntax the HTML form builder uses). Confirmed live:
      //   filter_float_price:to=1500  → total_elements drops to 30, all
      //                                organic items have price ≤ 1500
      //   filter_enum_rooms=two      → total_elements drops accordingly,
      //                                all items have rooms.key === 'two'
      if (filters.maxPrice != null) {
        params.set('filter_float_price:to', String(filters.maxPrice));
      }
      if (filters.minPrice != null) {
        params.set('filter_float_price:from', String(filters.minPrice));
      }
      // OLX only exposes 4 room buckets — only apply the filter when the user
      // asks for an exact single room count (minRooms === maxRooms) that maps
      // to a real OLX enum. A range like minRooms=2,maxRooms=3 cannot be
      // expressed in OLX's filter_enum_rooms (single value), so we leave it
      // off and let the runner's defensive filter handle it post-fetch.
      if (filters.minRooms != null && filters.minRooms === filters.maxRooms && ROOM_ENUM[filters.minRooms]) {
        params.set('filter_enum_rooms', ROOM_ENUM[filters.minRooms]);
      }

      const url = `${this.baseUrl}/api/v1/offers?${params.toString()}`;

      let json;
      try {
        json = await this._fetchJson(url);
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        console.warn(`[olx] API fetch failed for ${city.slug} page ${page + 1}:`, e.message,
          `(consecutive #${consecutiveFailures})`);
        // Transient HTTP failures (gateway 504, network blip) shouldn't
        // abort the whole walk — sleep 1.5s and try the next page. Only
        // after 3 consecutive failures do we bail (likely a hard block).
        if (consecutiveFailures >= 3) {
          console.error(`[olx] ${city.slug} ${consecutiveFailures} consecutive failures, aborting walk`);
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      const items = json.data || [];
      if (!items.length) {
        console.log(`[olx] ${city.slug} page ${page + 1}: no items, stopping`);
        emptyPage = true;
        break;
      }

      if (totalElements === null) {
        totalElements = json.metadata?.total_elements ?? null;
      }

      // Walk this page's items. OLX's "created_at:desc" sort is polluted by
      // promoted listings (old promoted ads appear at the top of every page),
      // so we can't break on the FIRST stale item. Instead, count how many
      // items on the page are newer than sinceTime; if NONE are, the next
      // page's items can only be older still — safe to stop there.
      let inWindow = 0;
      let processedOnPage = 0;
      for (const ad of items) {
        try {
          const l = this._normalize(ad, city);
          if (!l) continue;
          processedOnPage++;
          if (sinceTime && l.postedAt && new Date(l.postedAt) >= sinceTime) inWindow++;
          await emit(l);
        } catch {
          // skip broken ad
        }
      }
      console.log(
        `[olx] ${city.slug} page ${page + 1}: ${processedOnPage} ads (total ${seen}` +
        (sinceTime ? `, ${inWindow} newer than sinceTime` : '') + ')'
      );

      // Early-termination: nothing on this page is newer than sinceTime → stop.
      if (sinceTime && processedOnPage > 0 && inWindow === 0) {
        console.log(`[olx] ${city.slug} page ${page + 1}: no in-window items, stopping early`);
        break;
      }

      // Stop if we've consumed the full result set the API is willing to
      // return. OLX caps total_elements at 1000 — when offset + items.length
      // >= total_elements we've drained the feed.
      if (totalElements && offset + items.length >= totalElements) {
        console.log(`[olx] ${city.slug} reached API total_elements cap (${totalElements})`);
        break;
      }
    }

    // Optional: log how many ads pass the sinceTime filter (for debugging)
    if (sinceTime && allAds.length > 0) {
      const inWindow = allAds.filter(a => a.postedAt && new Date(a.postedAt) >= sinceTime).length;
      console.log(`[olx] ${city.slug}: ${inWindow} of ${allAds.length} ads are newer than sinceTime ${sinceTime.toISOString()}`);
    }

    return onListing ? [] : allAds;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // OLX's API exposes a clean JSON endpoint with sort_by=created_at:desc. We
  // fetch ONE page (limit=PAGE_LIMIT, offset=0) per city and return the
  // externalIds + postedAt + url. NO full normalize / no description / no
  // images — the watcher only needs the IDs for hash-based change detection
  // (H2-T3) and the last-seen-ID watermark short-circuit (H2-T4).
  //
  // `page` is ignored (OLX doesn't need a browser — plain `fetch` is fine
  // and there's no Datadome on the API path).
  //
  // Returns `[{ externalId, postedAt, url, cityId }]` ordered newest-first.
  async watchLatest(page, cities) {
    const out = [];
    for (const city of cities) {
      const info = CITY_INFO[city.slug];
      if (!info) continue;
      const params = new URLSearchParams();
      params.set('offset', '0');
      params.set('limit', String(PAGE_LIMIT));
      params.set('category_id', String(CATEGORY_ID));
      params.set('region_id', String(info.regionId));
      params.set('city_id', String(info.cityId));
      params.set('sort_by', 'created_at:desc');
      const url = `${this.baseUrl}/api/v1/offers?${params.toString()}`;
      let json;
      try {
        json = await this._fetchJson(url);
      } catch (e) {
        // Single-city failure shouldn't abort the whole tick — the circuit
        // breaker in alwaysOn.js counts this as one error toward the 3-strike
        // pause.
        console.warn(`[olx] watcher fetch failed for ${city.slug}:`, e.message);
        continue;
      }
      const items = json.data || [];
      for (const ad of items) {
        if (!ad || !ad.id) continue;
        // Skip promoted ads — they rotate within page 1 even without new
        // listings, and would pollute the hash (H2-§7 risk #2). Their stable
        // ids are still deduped by the (source_id, external_id) UNIQUE when
        // the watcher enqueues them via enqueueNewListing, but here in the
        // probe we just don't include them so the hash is stable.
        if (ad.promotion && !ad.created_time) continue;
        const listingUrl = ad.url?.startsWith('http')
          ? ad.url
          : `${this.baseUrl}${ad.url || ''}`;
        out.push({
          externalId: String(ad.id),
          postedAt: ad.created_time ? new Date(ad.created_time) : null,
          url: this._normalizeUrl(listingUrl),
          cityId: city.id
        });
      }
    }
    return out;
  }

  /**
   * Fetch JSON from OLX API v1. Separate from `BaseScraper._fetch` (which
   * returns text + uses a mobile UA by default) because the OLX API needs:
   *   - `Accept: application/json` (default text/html confuses the API gateway)
   *   - desktop UA (mobile UA still works but the API gateway occasionally
   *     503s on mobile UAs)
   */
  async _fetchJson(url, { timeout = 15000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // Per-listing detail-page fetcher used by the post-run enrichBackfill
  // pipeline (services/enrich.js) when an OLX listing is missing description
  // / coords / photos. Mirrors the fetchOneListing contract on otodom /
  // adresowo / gratka / morizon / domiporta / nieruchomosciOnline.
  //
  // OLX is unique among the D-chunk scrapers: it uses a public REST API
  // (https://www.olx.pl/api/v1/offers) for BOTH the search walk AND the
  // per-listing detail fetch. The search response already carries description
  // + map.lat/lon + photos[] on every item (verified on a 350-listing sample
  // walk: 0 missing desc, 0 missing coords, only 1-2 listings with <3 photos
  // which are genuine platform limits — partner listings or ads posted with
  // only 1 photo).
  //
  // The 9% missing-data gap in the pre-fix DB snapshot is therefore NOT a
  // search-API extraction bug — it's a THROUGHPUT issue:
  //   1. OLX's `created_at:desc` sort is polluted by promoted/partner ads
  //      that get bumped to the top of every page. Their `description` and
  //      `map` fields ARE present, but transient 5xx/network blips during
  //      the search walk can leave a listing with empty desc/null coords
  //      in the DB (the search walk is best-effort — `catch { /* skip */ }`
  //      silently drops broken ad items).
  //   2. Older cron runs may have hit OLX rate-limiting (429) or Datadome
  //      challenges that truncated the response body mid-stream, leaving
  //      partial JSON that parsed but with missing fields.
  //
  // The detail endpoint `/api/v1/offers/<numeric-id>` recovers these by
  // re-fetching the canonical record for that single listing. It returns
  // the SAME JSON shape as the search endpoint (`{ data: { ...ad } }`),
  // so we delegate to the existing `_normalize()` for consistency.
  //
  // Returns null on fetch failure (caller keeps the existing stub).
  // Returns the full normalized listing on success. Per-field gap
  // diagnostics surface missing-data patterns in the run log (same
  // pattern as the otodom/adresowo/morizon/domiporta fixes — Tasks
  // 4a/4b/4c/4d/4e).
  //
  // IMPORTANT: OLX URLs use an obfuscated short ID (e.g.
  //   https://www.olx.pl/d/oferta/...-ID1c5Ooz.html
  // ). The numeric ad ID is NOT in the URL. We rely on the `externalId`
  // passed in by the caller (enrich.js reads it from the listings table
  // where it was persisted by _normalize as String(ad.id)). If externalId
  // is missing, we cannot call the detail endpoint — return null.
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    const id = String(externalId || '').trim();
    if (!id || !/^\d+$/.test(id)) {
      console.warn(`[olx] fetchOneListing: missing/invalid externalId for ${url} (got "${id}") — OLX detail API requires numeric ad id`);
      return null;
    }
    const apiUrl = `${this.baseUrl}/api/v1/offers/${id}`;
    let json;
    try {
      json = await this._fetchJson(apiUrl, { timeout: 20000 });
    } catch (e) {
      console.warn(`[olx] fetchOneListing fetch failed for ${url} (${apiUrl}): ${e.message}`);
      return null;
    }
    const ad = json?.data;
    if (!ad || !ad.id) {
      console.warn(`[olx] fetchOneListing: no data block in response for ${url}`);
      return null;
    }
    // Delegate to the shared _normalize so the detail-page path and the
    // search-page path produce the same shape. _normalize returns null
    // when ad.id/title/price are missing (defensive — should not happen
    // for a successful detail-page fetch).
    let normalized;
    try {
      normalized = this._normalize(ad, city || { id: null, name: null, name_pl: null, slug: null });
    } catch (e) {
      console.warn(`[olx] fetchOneListing: _normalize threw for ${url}: ${e.message}`);
      return null;
    }
    if (!normalized) {
      console.warn(`[olx] fetchOneListing: _normalize returned null for ${url} (missing id/title/price?)`);
      return null;
    }
    // Post-enrichment gap diagnostics: surface listings where extraction
    // left gaps so the run log shows which URLs to investigate. Same shape
    // as the domiporta/nieruchomosciOnline fixes (Tasks 4d/4e).
    const gaps = [];
    if (!normalized.description || normalized.description.length < 50) gaps.push(`desc=${normalized.description?.length || 0}`);
    if (normalized.lat == null || normalized.lng == null) gaps.push('coords');
    if (!normalized.images || normalized.images.length < 3) gaps.push(`imgs=${normalized.images?.length || 0}`);
    if (gaps.length) {
      console.warn(`[olx] enrichment gap for ${url}: ${gaps.join(', ')}${ad.partner ? ` (partner=${ad.partner.code || ad.partner})` : ''}`);
    }
    return normalized;
  }

  _normalize(ad, city) {
    if (!ad || !ad.id || !ad.title) return null;

    // OLX API exposes price/rooms/area/floor inside `ad.params[]` — each
    // param has `{ key, value: { key, label, value? } }`. The `value.value`
    // field only exists on the `price` param (it's an integer); the others
    // use `value.key` (string slug) and `value.label` (Polish display string).
    const params = ad.params || [];
    const findParam = (key) => params.find(p => p.key === key);

    const priceParam = findParam('price');
    const price = priceParam?.value?.value
      || parseInt(String(priceParam?.value?.label || '0').replace(/[^\d]/g, ''), 10)
      || 0;
    if (!price) return null;

    const roomsParam = findParam('rooms');
    let rooms = null;
    if (roomsParam) {
      const k = roomsParam.value?.key;
      if (ROOM_NUMBER[k]) rooms = ROOM_NUMBER[k];
      else {
        const n = parseInt(String(roomsParam.value?.label || '').replace(/[^\d]/g, ''), 10);
        if (!isNaN(n)) rooms = n;
      }
    }

    const areaParam = findParam('m');
    const area = areaParam
      ? parseFloat(String(areaParam.value?.key || areaParam.value?.label || '0').replace(/[^\d.,]/g, '').replace(',', '.'))
      : null;

    const floorParam = findParam('floor_select');
    const floor = floorParam ? String(floorParam.value?.label || floorParam.value?.key || '') : null;

    const loc = ad.location || {};
    const district = loc.district?.name
      || (loc.city?.name && loc.city.name !== city.name_pl ? loc.city.name : null)
      || city.name_pl;

    // Photos — OLX API returns objects with a templated link:
    //   { id, filename, width, height, link: "https://...;s={width}x{height}" }
    // We substitute {width}x{height} with concrete values, preserving aspect
    // ratio and capping the longest side at 1280px (large enough for the UI
    // gallery + a robust pHash input; small enough to keep DB rows light).
    // The `filename` (e.g. "0puzcu8w3afk1-PL") is the stable photo identity —
    // the cross-provider phash dedupe (A6+B7) hashes the bytes at this URL.
    const images = (ad.photos || []).map(p => {
      if (typeof p === 'string') return p;
      const link = p?.link;
      if (!link) return p?.url || null;
      if (!link.includes('{width}')) return link;
      const w = p.width || 1280;
      const h = p.height || 960;
      let tw, th;
      if (w >= h) { tw = 1280; th = Math.max(1, Math.round(1280 * h / w)); }
      else { th = 1280; tw = Math.max(1, Math.round(1280 * w / h)); }
      return link.replace('{width}x{height}', `${tw}x${th}`);
    }).filter(Boolean);

    // Map coords — OLX API surfaces lat/lon directly on the search item
    // (unlike Otodom which only exposes them on the detail page).
    const lat = ad.map?.lat ?? null;
    const lng = ad.map?.lon ?? ad.map?.lng ?? null;

    // Description — full text, may contain <br /> and other HTML tags.
    // Strip tags but preserve line breaks from <br>.
    const description = String(ad.description || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+\n/g, '\n')
      .trim();

    const url = ad.url?.startsWith('http') ? ad.url : `${this.baseUrl}${ad.url || ''}`;

    // created_time carries the real "first posted" timestamp; last_refresh_time
    // is when the seller last pushed the ad up. We use created_time so an old
    // ad that's been pushed up doesn't show as "new" in the was_new detection.
    const postedAt = ad.created_time ? new Date(ad.created_time) : null;

    return {
      externalId: String(ad.id),
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: this._cleanText(ad.title),
      description,
      price: Math.round(price),
      currency: 'PLN',
      rooms,
      area,
      floor,
      district: district || city.name_pl,
      street: null,  // OLX search results don't expose street — only district
      address: loc.city?.name ? `${loc.city.name}, ${district}` : (district || city.name_pl),
      lat,
      lng,
      url: this._normalizeUrl(url),
      postedAt,
      images,
      conveniences: this._inferConveniences({ ...ad, params }),
      raw: {
        id: ad.id,
        url: ad.url,
        created_time: ad.created_time,
        last_refresh_time: ad.last_refresh_time,
        pushup_time: ad.pushup_time,
        business: ad.business,
        promotion: ad.promotion,
        partner: ad.partner,
        params
      }
    };
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. OLX's ad.url is already clean (no utm_*) when it comes
  // from the API, but normalizing defensively protects against future
  // regressions and against imported URLs with utm_*/fbclid etc.
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

  _cleanText(s) {
    if (!s) return '';
    return String(s).trim();
  }

  // Re-implement _inferConveniences against the OLX API param shape
  // (params[].value.{key,label} instead of params[].normalizedValue).
  _inferConveniences(ad) {
    const conv = [];
    const params = ad.params || [];
    const description = (ad.description || '').toLowerCase();
    const allText = [
      description,
      ...params.map(p => `${p.name}=${p.value?.label ?? p.value?.key ?? ''}`)
    ].join(' ').toLowerCase();

    const parkingParam = params.find(p => p.key === 'parking');
    const parkingLabel = parkingParam?.value?.label ?? parkingParam?.value?.key;
    if (parkingParam && parkingLabel && !/^brak$/i.test(String(parkingLabel))) {
      conv.push({ type: 'park', label: `Parking: ${parkingLabel}` });
    } else if (allText.match(/\bparking\b/)) {
      conv.push({ type: 'park', label: 'Parking' });
    }

    const liftParam = params.find(p => p.key === 'winda');
    if (liftParam && String(liftParam.value?.key || liftParam.value?.label || '').toLowerCase() === 'tak') {
      conv.push({ type: 'park', label: 'Lift' });
    }

    if (allText.match(/\b(silownia|gym|fitness|klub fitness)\b/)) {
      conv.push({ type: 'gym', label: 'Gym nearby' });
    }
    if (allText.match(/\b(centrum handlowe|gallery|galeria|mall|atrium|zlote tarasy|wola park)\b/)) {
      conv.push({ type: 'mall', label: 'Shopping mall' });
    }
    if (allText.match(/\b(biedronka|lidl|zabka|carrefour|auchan|kaufland|spar|lewiatan)\b/)) {
      const m = allText.match(/\b(biedronka|lidl|zabka|carrefour|auchan|kaufland|spar|lewiatan)\b/);
      if (m) conv.push({ type: 'market', label: `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} nearby` });
    }
    if (allText.match(/\b(park|park\s+\w+|skwer|las)\b/)) {
      const m = allText.match(/\b(park\s+[a-z\u00C0-\u017F]+|park|skwer|las)\b/);
      if (m) conv.push({ type: 'park', label: m[1].charAt(0).toUpperCase() + m[1].slice(1) });
    }
    if (allText.match(/\b(metro|tramwaj|autobus|stacja|przystanek)\b/)) {
      const m = allText.match(/\b(metro|tramwaj|autobus)\b/);
      if (m) conv.push({ type: 'transport', label: `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} nearby` });
    }
    return conv.slice(0, 5);
  }
}
