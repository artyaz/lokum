// Morizon scraper — same JSON-LD + Nuxt platform as Gratka (Grupa Morizon-Gratka).
//
// Warsaw inventory verified 2026-08-29: 3 000+ listings across 119 pages × 35/page
// (page 120 returns HTTP 404 = end of pagination). Page count matches morizon's
// advertised "ponad 3000 ogłoszeń" claim. With MAX_PAGES=30 → 1 050 listings/city/fetch
// (~33% of inventory). Pairs with the 3×/day recommended schedule (B8) so each
// fetch catches every listing added in the past ~8h with margin to spare.
//
// Default sort on the URL without the `/najnowsze/` path segment is REFRESHED_AT|DESC
// (most recently bumped by agent refresh). We override with the `/najnowsze/` path
// (ADDED_AT|DESC — morizon's "Data dodania / od najnowszych" sort URL) so the walk
// is newest-added-first → enables `sinceTime` short-circuit in the runner once
// `postedAt` is populated (which we do in `_enrichNew`).
//
// Mirrors gratka.js's post-B1 architecture (same platform, same Nuxt payload,
// same photo-extraction path). Same bug pattern as pre-fix gratka:
//   - MAX_PAGES=8 → captured only ~9% of inventory
//   - `supportsStreaming=true` → runner used the `onListing` callback path which
//     emits each listing as it's parsed from the search JSON-LD — but `_enrichNew`
//     (the only code that fetches detail pages for photos/desc/coords/postedAt)
//     was guarded by `if (!onListing)` and so NEVER ran in production. Every
//     morizon listing was persisted with NO coords, NO postedAt, 1 image (the
//     JSON-LD `offer.image`), and the short ~300-char search-block description.

import { BaseScraper } from './base.js';
import { extractProductOffers, normalizeOffer, externalIdFromUrl, extractGalleryPhotos, extractNuxtPhotos, extractDetailDescription, extractDetailCoords, extractDetailStreet, extractDetailPostedAt } from './jsonldProduct.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 5;
// 35 offers/page → 30 pages = ~1 050 listings/city/fetch (~33% of Warsaw's
// 3 000+ listing inventory). Pairs with the 3×/day recommended schedule (B8) so
// each fetch catches every listing added in the past ~8h with margin to spare.
// Bumped from 8 → 30 (Task B4): 8 pages captured only ~9% of inventory.
const MAX_PAGES = 30;
const ENRICH_LIMIT = 300;
const ENRICH_CONCURRENCY = 4;
// Morizon's per-page count is exactly 35 (same as gratka). Treat any short page
// as the last page (the true last page of a 3 000-listing feed has only ~6
// offers, well under 35).
const OFFERS_PER_PAGE = 35;
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// Cloudflare hiccups, DNS) — a single failure used to break the whole walk and
// silently drop pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;

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

export class MorizonScraper extends BaseScraper {
  // IMPORTANT: streaming disabled (despite prior `supportsStreaming = true`).
  // When streaming was on, the runner used the `onListing` callback path which
  // emits each listing as it's parsed from the search JSON-LD — but morizon's
  // detail-page enrichment (`_enrichNew`, which fetches photos / description /
  // coords / postedAt) was conditional on `!onListing` and so NEVER ran in
  // streaming mode. Result: every morizon listing persisted without coords,
  // without postedAt, with only 1 image (the JSON-LD `offer.image`) and the
  // short ~300-char search description. Disabling streaming keeps peak memory
  // slightly higher (~5 MB for 1 050 listings × ~5 KB payload) but ensures the
  // enrich step actually runs. (Same fix as B1 for gratka; B5 for adresowo.)
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'morizon', baseUrl: 'https://www.morizon.pl' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const maxPages = pageLimit('MORIZON_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      // `/najnowsze/` path segment → ADDED_AT|DESC (newest-added first). Without
      // this, morizon defaults to REFRESHED_AT|DESC (most-recently-refreshed
      // first), which mixes stale-but-recently-bumped listings into the top
      // pages and breaks any "stop early once we hit listings older than
      // sinceTime" assumption. (Equivalent of gratka's `?sort=newest` — morizon
      // uses path segments instead of query params for sort.)
      //
      // Nuxt payload reference (verified live on /do-wynajecia/mieszkania/warszawa/):
      //   data[3001] = "/do-wynajecia/mieszkania/najnowsze/warszawa/"  (ADDED_AT|DESC)
      //   data[3005] = "/do-wynajecia/mieszkania/najstarsze/warszawa/" (ADDED_AT|ASC)
      //   data[7]     = "/do-wynajecia/mieszkania/warszawa/"           (REFRESHED_AT|DESC, default)
      const params = new URLSearchParams();
      if (page > 1) params.set('page', String(page));
      if (filters.maxPrice != null) params.set('priceTo', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('priceFrom', String(filters.minPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/do-wynajecia/mieszkania/najnowsze/${cityPath}/${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true });
      } catch (e) {
        console.warn(`[morizon] fetch failed for ${city.slug} page ${page} (${e.message}), trying browser…`);
        try { html = await fetchRendered(url); }
        catch (e2) {
          console.error(`[morizon] browser fetch failed for ${city.slug} page ${page}:`, e2.message);
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[morizon] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
            break;
          }
          // Back off briefly so a transient 5xx / Cloudflare blip doesn't
          // cascade into a hard abort and skip the remaining pages.
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }
      consecutiveFailures = 0; // reset on success

      const offers = extractProductOffers(html);
      if (!offers.length) {
        if (page === 1) console.warn(`[morizon] ${city.slug}: no offers found on page 1`);
        else console.log(`[morizon] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      for (const offer of offers) {
        try {
          const n = normalizeOffer(offer);
          if (!n) continue;
          const externalId = externalIdFromUrl(n.url);
          if (!externalId) continue;
          const listing = {
            externalId,
            sourceId: SOURCE_ID,
            cityId: city.id,
            title: n.title || `Mieszkanie ${n.district || city.name_pl}`,
            description: n.description,
            price: n.price,
            currency: 'PLN',
            rooms: n.rooms,
            area: n.area,
            floor: n.floor,
            district: n.district || city.name_pl,
            street: n.street,
            address: n.address,
            lat: null,
            lng: null,
            url: n.url,
            postedAt: null, // backfilled from detail page in _enrichNew (Nuxt payload GMT date)
            images: n.images,
            conveniences: [],
            raw: { url: n.url, params: n.params }
          };
          if (onListing) await onListing(listing);
          else ads.push(listing);
        } catch (e) {
          // Logged catch (was silent `catch {}` — a JSON-LD parse failure on
          // a single offer used to be invisible). Logs the offer URL so a
          // malformed-offer pattern is diagnosable from the run log.
          console.warn(`[morizon] ${city.slug}: normalize/emit failed for offer:`, e.message);
        }
      }
      console.log(`[morizon] ${city.slug} page ${page}: ${offers.length} offers (total ${ads.length})`);
      if (offers.length < OFFERS_PER_PAGE) break; // short page = last page
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // Same JSON-LD + Nuxt platform as gratka (Grupa Morizon-Gratka). Loads
  // page 1 of the morizon search results on `/najnowsze/` (ADDED_AT|DESC)
  // via the source's persistent BrowserContext, parses JSON-LD, and
  // returns `[{ externalId, postedAt, url, cityId }]`.
  async watchLatest(page, cities) {
    const out = [];
    for (const city of cities) {
      const cityPath = CITY_PATH[city.slug];
      if (!cityPath) continue;
      const url = `${this.baseUrl}/do-wynajecia/mieszkania/najnowsze/${cityPath}/`;
      let html;
      try {
        if (page) {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (!resp || resp.status() >= 400) {
            throw new Error(`HTTP ${resp ? resp.status() : 'no-response'}`);
          }
          await page.waitForTimeout(500);
          html = await page.content();
        } else {
          html = await this._fetch(url, { desktop: true });
        }
      } catch (e) {
        console.warn(`[morizon] watcher fetch failed for ${city.slug}:`, e.message);
        continue;
      }
      const offers = extractProductOffers(html);
      for (const offer of offers) {
        try {
          const n = normalizeOffer(offer);
          if (!n) continue;
          const externalId = externalIdFromUrl(n.url);
          if (!externalId) continue;
          out.push({
            externalId,
            postedAt: null,
            url: n.url,
            cityId: city.id
          });
        } catch {}
      }
    }
    return out;
  }

  // Per-listing detail fetch (Task I — H4 design). Identical pattern to
  // gratka.js#fetchOneListing — same Nuxt payload, same extractors.
  //
  // Probed 12 live listings (Task 4c, 8 no-coords + 4 with-coords in DB):
  // ALL 12 returned HTTP 200 with full HTML (~430-550 KB), ALL 12 had coords
  // extracted by extractDetailCoords (via the JSON-LD "geo"{"latitude":X,"longitude":Y}
  // regex), ALL 12 had description 1.4-6.3k chars, ALL 12 had 6-20 Nuxt photos
  // (avg 14.25). So the extraction logic is bulletproof on real morizon HTML.
  // The 59% missing-coords stat is a THROUGHPUT issue (post-run enrichBackfill
  // capped at 200/source/cycle, ~1050 listings fetched/cycle) — same root cause
  // as adresowo (Task 4b). This fix (1) uses extractGalleryPhotos for the regex
  // fallback on CF-challenge shells, (2) adds per-field try/catch so a single
  // broken field can't abort the rest, (3) logs post-enrichment gaps so missing
  // data shows up in the run log instead of silently persisting.
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    let html;
    try {
      html = await this._fetch(url, { desktop: true });
    } catch (e) {
      console.warn(`[morizon] fetchOneListing fetch failed for ${url}:`, e.message);
      return null;
    }
    const out = {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city?.id,
      title: 'Pending enrichment',
      description: '',
      price: 0,
      currency: 'PLN',
      rooms: null,
      area: null,
      floor: null,
      district: city?.name_pl,
      street: null,
      address: null,
      lat: null,
      lng: null,
      url,
      postedAt: null,
      images: [],
      conveniences: [],
      raw: {}
    };
    // Per-field try/catch — a single broken field (e.g. a malformed JSON-LD
    // geo block on an edge-case listing) no longer aborts all subsequent
    // extraction. Each branch logs the failure + URL so missing-data patterns
    // are visible in the run log instead of being silently swallowed.
    try {
      const desc = extractDetailDescription(html);
      if (desc) out.description = desc;
    } catch (e) { console.warn(`[morizon] desc extract failed for ${url}:`, e.message); }
    try {
      const coords = extractDetailCoords(html);
      if (coords) { out.lat = coords.lat; out.lng = coords.lng; }
    } catch (e) { console.warn(`[morizon] coords extract failed for ${url}:`, e.message); }
    try {
      const postedAt = extractDetailPostedAt(html);
      if (postedAt) out.postedAt = postedAt;
    } catch (e) { console.warn(`[morizon] postedAt extract failed for ${url}:`, e.message); }
    try {
      const street = extractDetailStreet(html);
      if (street) {
        out.street = street;
        out.address = street ? `${street}, ${city?.name_pl || ''}`.trim().replace(/,$/, '') : null;
      }
    } catch (e) { console.warn(`[morizon] street extract failed for ${url}:`, e.message); }
    try {
      // Use extractGalleryPhotos (Nuxt-first, regex fallback) instead of just
      // extractNuxtPhotos — the regex path catches the 4 visible carousel
      // thumbs when a CF challenge shell strips the __NUXT_DATA__ script.
      const photos = extractGalleryPhotos(html);
      if (photos.length) out.images = photos;
    } catch (e) { console.warn(`[morizon] photos extract failed for ${url}:`, e.message); }

    // Post-enrichment gap diagnostics — surfaces missing-data patterns to
    // the run log so coordinator can spot systemic issues (e.g. if a morizon
    // page redesign breaks coords extraction across many listings at once).
    const gaps = [];
    if (!out.description || out.description.length < 50) gaps.push(`desc<50c (${out.description?.length || 0})`);
    if (out.lat == null || out.lng == null) gaps.push('no-coords');
    if (!out.images || out.images.length < 3) gaps.push(`imgs<3 (${out.images?.length || 0})`);
    if (gaps.length) console.warn(`[morizon] enrichment gap for ${externalId || url}: ${gaps.join(', ')}`);

    return out;
  }

  // Search JSON-LD carries ONE photo per listing (the `offer.image` field) —
  // fetch the detail pages of new listings AND known listings with insufficient
  // images.
  //
  // PHOTO-FETCH STRATEGY (Task B4 — verified 2026-08-29 on listing mzn2047859771):
  // Same Nuxt platform as gratka (Grupa Morizon-Gratka). The morizon detail
  // page server-renders only ~4 unique thumb URLs in its visible carousel
  // (cover + 3 gallery thumbs), even though the listing advertises 7-20 photos
  // in its meta description. All photo URLs are embedded in the SAME detail-page
  // HTML, inside the `<script id="__NUXT_DATA__" type="application/json">` block,
  // as a flat JSON array of base64-encoded URLs — same layout as gratka. The
  // shared `extractNuxtPhotos` (in jsonldProduct.js, formerly
  // `extractGratkaNuxtPhotos`) walks that array's propertyData.photos[] chain,
  // decodes each entry's base64 `id`, and returns up to 20 full-res URLs.
  // Verified live on 3 morizon listings:
  //   - mzn2047859771 (Rycerska, 48m²)  → 8 photos (advertised 8)
  //   - mzn2047104390 (Limanowskiego)   → 7 photos (advertised 7)
  //   - mzn2047928456 (Oboźna, 60m²)    → 20 photos (advertised 20+)
  // All photos are on the gratka CDN (`https://d-gr.cdngr.pl/...`) — morizon
  // shares gratka's photo hosting infrastructure.
  //
  // CONCURRENCY: morizon.js already uses a 4-worker Promise pool
  // (`ENRICH_CONCURRENCY = 4`) — this satisfies the "Promise pool of 4 when
  // fetching many listing photo pages in a single scraper run" requirement. No
  // separate fetch is needed because all photo URLs come from the same
  // detail-page HTML that's already fetched for description/coords/postedAt
  // enrichment — saves one HTTP request per listing vs. the naive approach.
  //
  // STORAGE: photos are stored as URL strings only (no downloaded bytes) —
  // `persistListing` in base.js writes them to `listing_images.url` column.
  // The cross-source phash worker (A6+B7) fetches the bytes from the URL on
  // demand to compute the pHash for cross-provider dedupe.
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
    console.log(`[morizon] enriching ${fresh.length} listings (photos/desc/coords/postedAt)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true });
          // Primary: __NUXT_DATA__ payload (renamed `extractNuxtPhotos` —
          // formerly `extractGratkaNuxtPhotos`). Returns up to 20 full-res
          // URLs (verified 8/7/20 on the 3 test listings above). Fallback:
          // the regex path (≤4 photos) if the Nuxt payload is missing
          // (CF shell, browser-rendered).
          const nuxtPhotos = extractNuxtPhotos(html);
          if (nuxtPhotos.length) ad.images = nuxtPhotos;
          else {
            const photos = extractGalleryPhotos(html);
            if (photos.length) ad.images = photos;
          }
          const desc = extractDetailDescription(html);
          if (desc && desc.length > (ad.description || '').length) ad.description = desc;
          const coords = extractDetailCoords(html);
          if (coords) { ad.lat = coords.lat; ad.lng = coords.lng; }
          const street = extractDetailStreet(html);
          if (street && !ad.street) {
            ad.street = street;
            ad.address = [street, ad.district].filter(Boolean).join(', ');
          }
          // postedAt is the listing's addedAt — extracted from the Nuxt
          // payload (not JSON-LD). With this populated, the runner can use
          // `postedAt >= sinceTime` for accurate "new" detection; without it,
          // the runner falls back to "not seen in previous run" (less precise,
          // and confounded by B8's global getSinceTime() bug).
          // Verified live on mzn2047859771: Nuxt payload contains
          //   "mzn2047859771","Thu, 20 Aug 2026 19:14:41 GMT","2026-08-29 16:35:45"
          // The first GMT string is addedAt; the second datetime (without GMT) is
          // refreshed_at — `extractDetailPostedAt` correctly prefers the GMT form.
          const postedAt = extractDetailPostedAt(html);
          if (postedAt) ad.postedAt = postedAt;

          // Post-enrichment gap diagnostics — surfaces missing-data patterns
          // to the run log instead of silently persisting incomplete listings.
          const gaps = [];
          if (!ad.description || ad.description.length < 50) gaps.push(`desc<50c`);
          if (ad.lat == null || ad.lng == null) gaps.push('no-coords');
          if (!ad.images || ad.images.length < 3) gaps.push(`imgs<3 (${ad.images?.length || 0})`);
          if (gaps.length) console.warn(`[morizon] enrichment gap for ${ad.externalId}: ${gaps.join(', ')}`);
        } catch (e) {
          // Logged catch (was silent `catch {}` — a fetch/parse failure used to
          // be invisible). Logs the listing URL so missing-data patterns are
          // diagnosable from the run log.
          console.warn(`[morizon] _enrichNew failed for ${ad.externalId || ad.url}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }
}
