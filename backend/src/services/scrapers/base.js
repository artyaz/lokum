// Base scraper interface. Each scraper returns an array of normalized listing objects:
// {
//   externalId, source, cityId, title, price, currency, rooms, area, floor,
//   district, street, address, lat, lng, url, postedAt, images[], conveniences[{type,label}], raw
// }

import { query, one } from '../../db.js';

export class BaseScraper {
  // Streaming scrapers consume options.onListing and avoid retaining the whole
  // city's normalized listings before the runner persists them.
  supportsStreaming = false;

  constructor({ sourceId, sourceSlug, baseUrl }) {
    this.sourceId = sourceId;
    this.sourceSlug = sourceSlug;
    this.baseUrl = baseUrl;
  }

  // Override in subclass. Returns array of normalized listings.
  // city = { id, name, name_pl, slug, lat, lng }
  // options = { filters: {maxPrice, minRooms, maxRooms}, sinceTime: Date|null }
  //   - filters: applied at the source (URL) level when possible
  //   - sinceTime: when set, scraper can stop paginating once it encounters
  //     listings older than this. Returns all listings found, with each listing's
  //     `postedAt` set so the runner can compute was_new.
  async fetchCity(city, options = {}) {
    throw new Error('not implemented');
  }

  // Lightweight probe used by the always-on watcher (Task I — H4 design).
  //
  // Returns `[{ externalId, postedAt, url, cityId }]` for the newest listings
  // on page 1 of this source's search feed. Does NOT run full normalize /
  // detail-page enrichment — the watcher uses the returned externalIds for
  // hash-based change detection (H2-T3) and last-seen-ID watermark short-
  // circuit (H2-T4). When a new externalId is detected, the watcher calls
  // `enqueueNewListing(...)` in runner.js, which (a) inserts a stub listing
  // so it's visible immediately + (b) schedules a background full-detail
  // enrichment pipeline (the next full-cron run will re-fetch + re-persist
  // with full data).
  //
  // `page` is a Playwright Page on the source's persistent context, OR null
  // for sources that don't need a browser (OLX uses plain fetch). `cities`
  // is the array of city rows to probe — typically the same list the runner
  // uses for the full cron. Implementations may probe all cities in one call
  // (a single multi-city API request) or one city at a time.
  //
  // Default impl returns [] — watchers for sources without a `watchLatest`
  // override simply skip that source (the full-cron ground-truth re-sync
  // every ~30 min is the catch-all).
  async watchLatest(page, cities) {
    return [];
  }

  // Per-listing detail-page fetcher used by `enqueueNewListing` in runner.js
  // (Task I — H4 design). Called only for listings the watcher newly detected.
  //
  // Returns a partial listing object suitable for `persistListing()` —
  // at minimum `{ externalId, sourceId, cityId, url, postedAt, title,
  // description, price, currency, ... }`. Fields that can only be derived
  // from the search-result page (price/rooms/area for some sources) MAY
  // be left null/0 — the next full-cron run will UPSERT the full data.
  //
  // Returns null when per-listing fetch is not feasible for this source
  // (OLX API has no item-by-id endpoint; Facebook bridge is group-feed
  // based). For such sources, the watcher just inserts a stub listing
  // (`enqueueNewListing` handles the null return).
  //
  // Default impl: return null. Override per-scraper when a detail-page
  // fetch + applyDetail path exists (otodom / gratka / morizon / adresowo).
  async fetchOneListing(url, { city, externalId } = {}) {
    return null;
  }

  // Helper: fetch HTML with browser-like headers.
  //
  // Default timeout lowered from 30s to 15s (Task A2): a hung connection
  // otherwise pins 30s of CPU + an in-flight string buffer per failed call.
  // Scrapers that hit a slow endpoint can still override with `timeout:`.
  async _fetch(url, { timeout = 15000, desktop = false } = {}) {
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
        signal: controller.signal,
        // Use `auto` (Node default) — lets Node handle gzip/deflate/br without
        // the cost of decompression in JS land; content-length stays the wire
        // size, so the response buffer is the decompressed text only.
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  // Run an async mapper over `items` with a bounded worker pool. Replaces
  // ad-hoc `Promise.all(items.map(...))` patterns that spike RAM when the
  // array is large — a pool of `concurrency` (default 4) keeps the in-flight
  // list of pending promises + their resolved values bounded.
  //
  // Use this for detail-page enrichment where items.length can be 100+:
  //   await this._pooledMap(fresh, 4, async (ad) => this._enrichOne(ad))
  async _pooledMap(items, concurrency, fn) {
    const n = Math.max(1, Math.min(concurrency || 1, items.length));
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { await fn(items[i], i); } catch {}
      }
    }
    const workers = [];
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // Helper: extract first JSON-LD or parse __NEXT_DATA__
  _extractJson(text) {
    // try __NEXT_DATA__
    const m1 = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (m1) {
      try { return JSON.parse(m1[1]); } catch {}
    }
    return null;
  }

  // Helper: extract all <script type="application/ld+json"> blocks
  _extractJsonLd(text) {
    const out = [];
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      try { out.push(JSON.parse(m[1])); } catch {}
    }
    return out;
  }

  // Helper: regex-based text extraction
  _matchAll(str, regex) {
    const out = [];
    let m;
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(str)) !== null) {
      out.push(m);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }
}

// Persist a normalized listing into the DB. Returns { listing, isNew }.
export async function persistListing(l) {
  // upsert listing
  const r = await one(
    `INSERT INTO listings
       (source_id, external_id, city_id, title, description, price, currency, rooms, area, floor,
        district, street, address, lat, lng, url, posted_at, first_seen_at, last_seen_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW(), $18::jsonb)
     ON CONFLICT (source_id, external_id) DO UPDATE
       SET last_seen_at = NOW(),
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           price = EXCLUDED.price,
           rooms = EXCLUDED.rooms,
           area = EXCLUDED.area,
           floor = EXCLUDED.floor,
           district = EXCLUDED.district,
           street = EXCLUDED.street,
           address = EXCLUDED.address,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           url = EXCLUDED.url,
           posted_at = COALESCE(EXCLUDED.posted_at, listings.posted_at),
           is_active = TRUE,
           raw = EXCLUDED.raw
     RETURNING id, (xmax = 0) AS is_new, first_seen_at`,
    [
      l.sourceId, l.externalId, l.cityId, l.title, l.description || '', l.price, l.currency || 'PLN',
      l.rooms || null, l.area || null, l.floor || null,
      l.district || null, l.street || null, l.address || null,
      l.lat || null, l.lng || null, l.url, l.postedAt || null,
      JSON.stringify(l.raw || {})
    ]
  );
  const listingId = r.id;
  const isNew = r.is_new;

  // images: replace
  if (l.images && l.images.length) {
    await query(`DELETE FROM listing_images WHERE listing_id = $1`, [listingId]);
    // Task A2: single multi-row INSERT via `unnest` replaces a per-row
    // loop. Cuts per-listing DB round-trips from N (up to 20) to 1 — across
    // a 1 000-listing run with ~10 photos each, that's ~10 000 → ~1 000
    // queries, freeing the pg pool slot back sooner and halving the
    // event-loop time spent on persistence.
    const imgs = l.images.slice(0, 20);
    const urls = imgs.map(String);
    const positions = imgs.map((_, i) => i);
    await query(
      `INSERT INTO listing_images (listing_id, url, position)
       SELECT $1, url, pos FROM unnest($2::text[], $3::int[]) AS t(url, pos)`,
      [listingId, urls, positions]
    );
  }

  // conveniences: replace
  if (l.conveniences && l.conveniences.length) {
    await query(`DELETE FROM listing_conveniences WHERE listing_id = $1`, [listingId]);
    // Task A2: same batched-INSERT pattern as images above.
    const convs = l.conveniences.slice(0, 12);
    const types = convs.map(c => String(c.type));
    const labels = convs.map(c => String(c.label));
    await query(
      `INSERT INTO listing_conveniences (listing_id, type, label)
       SELECT $1, t.type, t.label
         FROM unnest($2::text[], $3::text[]) AS t(type, label)
       ON CONFLICT DO NOTHING`,
      [listingId, types, labels]
    );
  }

  return { listingId, isNew };
}
