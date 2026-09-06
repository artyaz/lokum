// Post-run enrichment backfill.
//
// After each scrape cycle, many listings lack descriptions, coordinates, or
// have only a single thumbnail image — because the per-scraper enrichment is
// capped (40/city) and only targets brand-new listings. This service fills
// those gaps by re-visiting detail pages for active listings with missing data.
//
// Designed to run as the LAST phase of a fetch cycle (after dedup/telegram),
// bounded by time and concurrency to avoid overloading sources.

import { query, many } from '../db.js';
import { extractGalleryPhotos, extractDetailDescription, extractDetailCoords, extractDetailStreet } from './scrapers/jsonldProduct.js';
// pHash worker — when enrichment replaces a listing's images, the cover
// photo may change. We invalidate the cached photo_phash + cross-provider
// duplicate relationship and recompute. (Lazy import avoids loading the
// full dedupe module when no listings need image replacement this cycle.)
let _dedupeModule = null;
async function getDedupe() {
  if (_dedupeModule) return _dedupeModule;
  _dedupeModule = await import('./dedupe.js');
  return _dedupeModule;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONCURRENCY = 3;
const DELAY_MS = 150;
const MAX_PER_SOURCE = parseInt(process.env.ENRICH_MAX_PER_SOURCE || 200, 10); // raised via env when converging after bulk walks
const MAX_TOTAL_TIME_MS = parseInt(process.env.ENRICH_MAX_TOTAL_MS || 480000, 10); // 8 min default; env-overridable for convergence runs

// Lazy import of the scraper registry (avoids circular dependency:
// runner.js imports enrichBackfill from here, so we can't statically import
// runner.js at module-load time). When the backfill runs, runner.js is fully
// loaded so the dynamic import resolves instantly.
let _SCRAPERS = null;
async function getScrapers() {
  if (_SCRAPERS) return _SCRAPERS;
  const m = await import('./runner.js');
  _SCRAPERS = m.SCRAPERS_BY_ID || m.default?.SCRAPERS_BY_ID;
  return _SCRAPERS;
}

async function fetchHtml(url, timeout = 15000) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

// --- Otodom detail page ---
function parseOtodomDetail(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const d = data?.props?.pageProps?.ad;
  if (!d) return null;

  const result = {};
  if (d.location?.coordinates) {
    result.lat = d.location.coordinates.latitude ?? null;
    result.lng = d.location.coordinates.longitude ?? null;
  }
  if (d.description) {
    result.description = String(d.description).replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  if (Array.isArray(d.images) && d.images.length) {
    result.images = d.images.map(im => im?.large || im?.medium).filter(Boolean);
  }
  if (d.location?.address?.street?.name) {
    result.street = d.location.address.street.name;
  }
  return result;
}

// --- Adresowo detail page ---
function parseAdresowoDetail(html, url) {
  const result = {};
  const latM = html.match(/re\.geo\.lat\s*=\s*([\d.]+)/);
  const lngM = html.match(/re\.geo\.lng\s*=\s*([\d.]+)/);
  if (latM && lngM) {
    result.lat = parseFloat(latM[1]);
    result.lng = parseFloat(lngM[1]);
  }

  const descM = html.match(/<p id="description"[^>]*>([\s\S]*?)<\/p>/);
  if (descM) {
    result.description = String(descM[1])
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/\s{2,}/g, ' ').trim();
  }

  const slugCore = url.split('/o/')[1] || '';
  const coreMatch = slugCore.match(/^(mieszkanie-wynajem-[a-z0-9-]+?)-\d-pokojowe/i) ||
                    slugCore.match(/^(mieszkanie-wynajem-[a-z0-9-]+?)-[a-z0-9]{5,6}$/i);
  const core = coreMatch ? coreMatch[1] : slugCore.replace(/-[a-z0-9]{5,6}$/i, '');
  const allImgs = [...html.matchAll(/https:\/\/s\d\.adresowa\.pl\/oi\/[^"'\s\\]+?\.(?:jpg|webp)/g)]
    .map(m => m[0])
    .filter(u => u.includes(core) || u.includes('adresowa.pl/oi/'));
  const SIZE_PRIO = { xbig: 4, big: 3, cover: 2, small: 1 };
  const byHash = new Map();
  for (const u of allImgs) {
    const hm = u.match(/\/oi\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{6}_[0-9a-f]{4})/);
    if (!hm) continue;
    const hash = hm[1];
    const sizeM = u.match(/_(xbig|big|cover|small)/);
    const size = sizeM ? sizeM[1] : 'cover';
    const prio = SIZE_PRIO[size] || 2;
    if (!byHash.has(hash) || prio > byHash.get(hash).prio) {
      byHash.set(hash, { url: u.replace(/@(2x|3x)/, ''), prio });
    }
  }
  const uniq = [...byHash.values()].map(v => v.url);
  if (uniq.length) result.images = uniq.slice(0, 12);

  return result;
}

// --- Gratka/Morizon detail page ---
function parseGratkaMorizonDetail(html) {
  const result = {};
  const photos = extractGalleryPhotos(html);
  if (photos.length) result.images = photos;

  const desc = extractDetailDescription(html);
  if (desc) result.description = desc;

  const coords = extractDetailCoords(html);
  if (coords) {
    result.lat = coords.lat;
    result.lng = coords.lng;
  }

  const street = extractDetailStreet(html);
  if (street) result.street = street;

  return result;
}

async function applyEnrichment(listing, data) {
  const sets = [];
  const params = [];
  let idx = 1;

  if (data.lat != null && data.lng != null && listing.lat == null) {
    sets.push(`lat = $${idx++}`, `lng = $${idx++}`);
    params.push(data.lat, data.lng);
  }
  if (data.description && data.description.length > (listing.description || '').length + 20) {
    sets.push(`description = $${idx++}`);
    params.push(data.description);
  }
  if (data.street && !listing.street) {
    sets.push(`street = $${idx++}`);
    params.push(data.street);
  }

  if (sets.length) {
    params.push(listing.id);
    await query(`UPDATE listings SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  }

  if (data.images && data.images.length > listing.nimgs) {
    await query(`DELETE FROM listing_images WHERE listing_id = $1`, [listing.id]);
    let i = 0;
    for (const url of data.images.slice(0, 20)) {
      await query(`INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, $3)`, [listing.id, url, i++]);
    }
    // Cover photo may have changed → invalidate cached pHash + cross-provider
    // duplicate relationship so a stale photo_phash doesn't keep the listing
    // paired with an old canonical. Best-effort recompute; the photo fetch is
    // bounded by the 12s timeout inside computePhotoPhash. On failure the
    // next phashBackfill (admin endpoint) or next dedupeForListings (only
    // for new listings) picks it up.
    await query(
      `UPDATE listings SET photo_phash = NULL, duplicate_of_id = NULL, duplicate_source = NULL WHERE id = $1`,
      [listing.id]
    );
    try {
      const { computeAndStorePhotoPhash, findPhashDuplicate } = await getDedupe();
      const ok = await computeAndStorePhotoPhash(listing.id);
      if (ok) await findPhashDuplicate(listing.id);
    } catch (e) {
      // swallow — best-effort; dedupeScanCity will catch the next cycle
    }
  }
}

/**
 * Run enrichment backfill for listings missing data.
 * Called after the main scrape + dedup + telegram phases.
 *
 * Two paths:
 *   1. Inline parser for source 4 (gratka) — predates the
 *      scraper.fetchOneListing API and is kept for parity.
 *   2. For every OTHER source, delegate to scraper.fetchOneListing(url, {city, externalId})
 *      when the scraper implements it (BaseScraper default returns null).
 *      This is the path that covers olx, domiporta, nieruchomosci-online,
 *      sprzedajemy, odwlasciciela, oferty-net, wynajem24, rentola, gethome,
 *      lento, okolica, tabelaofert, bezposrednio, telegram, otodom (Task 4a),
 *      adresowo (Task 4b), and morizon (Task 4c).
 */
export async function enrichBackfill() {
  const startTime = Date.now();

  // Find active listings missing critical data, capped per source for fairness.
  // Also fetch city_id + external_id so we can call scraper.fetchOneListing().
  const targets = await many(`
    SELECT id, url, source_id, city_id, external_id, description, lat, street, nimgs FROM (
      SELECT l.id, l.url, l.source_id, l.city_id, l.external_id, l.description, l.lat, l.street,
             (SELECT count(*) FROM listing_images WHERE listing_id = l.id) AS nimgs,
             ROW_NUMBER() OVER (PARTITION BY l.source_id ORDER BY l.first_seen_at DESC) AS rn
      FROM listings l
      WHERE l.is_active = TRUE
        AND l.url IS NOT NULL AND l.url != ''
        AND (
          l.description = '' OR l.description IS NULL
          OR l.lat IS NULL
          OR (SELECT count(*) FROM listing_images WHERE listing_id = l.id) <= 1
        )
    ) ranked WHERE rn <= $1
  `, [MAX_PER_SOURCE]);

  if (!targets.length) {
    console.log('[enrich] no listings need enrichment');
    return { enriched: 0, targets: 0 };
  }

  const work = targets;
  console.log(`[enrich] ${work.length} listings to enrich`);

  let enriched = 0;
  let failed = 0;
  let idx = 0;

  // Load the scraper registry lazily (see getScrapers comment).
  const SCRAPERS = await getScrapers();

  // Cache city rows by id so we don't re-query per listing.
  const cityCache = new Map();
  async function getCity(cityId) {
    if (!cityId) return null;
    if (cityCache.has(cityId)) return cityCache.get(cityId);
    const { one } = await import('../db.js');
    const c = await one(`SELECT id, name, name_pl, slug, lat, lng FROM cities WHERE id = $1`, [cityId]);
    cityCache.set(cityId, c);
    return c;
  }

  async function worker() {
    while (idx < work.length) {
      if (Date.now() - startTime > MAX_TOTAL_TIME_MS) {
        console.log('[enrich] time limit reached');
        return;
      }
      const listing = work[idx++];
      try {
        let data = null;

        // Path 1: inline parsers for sources that predate fetchOneListing.
        // NOTE: source 2 (otodom) was moved to the fetchOneListing path
        // (default branch below) so the improved _applyDetail in
        // otodom.js (entity decoding, thumbnail fallback, error logging)
        // is the single source of truth for otodom enrichment.
        // NOTE: source 3 (adresowo) was similarly moved to fetchOneListing
        // (Task 4b) so the improved _applyDetail in adresowo.js (JSON-LD
        // coord fallback, og:image attribute-order robustness, per-field
        // try/catch with logged warnings, post-enrichment gap diagnostics)
        // is the single source of truth for adresowo enrichment. The inline
        // parseAdresowoDetail had a known image-filter bug (the `||u.includes
        // ('adresowa.pl/oi/')` clause was always true → sidebar leakage).
        // NOTE: source 5 (morizon) was similarly moved to fetchOneListing
        // (Task 4c). Probed 12 live listings: ALL 12 returned HTTP 200 with
        // coords/desc/photos extractable via the shared extractors in
        // jsonldProduct.js (avg 14.25 Nuxt photos). The 59% missing-coords
        // backlog is a THROUGHPUT issue (post-run cap 200/source/cycle vs.
        // ~1050 listings fetched/cycle), not an extraction bug — same root
        // cause as adresowo. Routing through scraper.fetchOneListing makes
        // morizon.js the single source of truth (per-field try/catch, gap
        // diagnostics, extractGalleryPhotos regex fallback for CF shells).
        switch (listing.source_id) {
          default: {
            // Path 2: delegate to the scraper's own fetchOneListing method.
            // BaseScraper default returns null; only scrapers that override
            // fetchOneListing will produce enrichment data here.
            const scraper = SCRAPERS && SCRAPERS[listing.source_id];
            if (scraper && typeof scraper.fetchOneListing === 'function') {
              const city = await getCity(listing.city_id);
              if (city) {
                const full = await scraper.fetchOneListing(listing.url, {
                  city,
                  externalId: listing.external_id
                });
                if (full) {
                  data = {
                    lat: full.lat ?? null,
                    lng: full.lng ?? null,
                    description: full.description || '',
                    images: full.images || [],
                    street: full.street || null
                  };
                  // Strip nulls/empties so applyEnrichment doesn't overwrite
                  // existing data with blanks.
                  for (const k of Object.keys(data)) {
                    if (data[k] === null || data[k] === '' ||
                        (Array.isArray(data[k]) && !data[k].length)) {
                      delete data[k];
                    }
                  }
                }
              }
            }
            break;
          }
        }

        if (data) {
          await applyEnrichment(listing, data);
          enriched++;
        }
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  console.log(`[enrich] done — enriched: ${enriched}, failed: ${failed}, elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return { enriched, failed, targets: work.length };
}
