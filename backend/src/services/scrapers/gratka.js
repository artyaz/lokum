// Gratka scraper — listings come from JSON-LD (Product → AggregateOffer → offers)
// in server-rendered HTML. No JS needed.
//
// Warsaw inventory verified 2026-08-29: 3 996 listings across 115 pages × 35/page.
// Default sort on the URL without `?sort=` is REFRESHED_AT DESC (most recently
// bumped by agent refresh). We override with `?sort=newest` (ADDED_AT DESC) so
// the walk is newest-added-first → enables `sinceTime` short-circuit in the
// runner once `postedAt` is populated (which we do in `_enrichNew`).

import { BaseScraper } from './base.js';
import { extractProductOffers, normalizeOffer, externalIdFromUrl, extractGalleryPhotos, extractGratkaNuxtPhotos, extractDetailDescription, extractDetailCoords, extractDetailStreet, extractDetailPostedAt } from './jsonldProduct.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 4;
// 35 offers/page → 30 pages = ~1 050 listings/city/fetch (~26% of Warsaw's
// 3 996-listing inventory). Pairs with the 3×/day recommended schedule (B8) so
// each fetch catches every listing added in the past ~8h with margin to spare.
// Bumped from 8 → 30 (Task B1): 8 pages captured only 7% of inventory.
const MAX_PAGES = 30;
const ENRICH_LIMIT = 300;
const ENRICH_CONCURRENCY = 4;
// Gratka's per-page count is exactly 35. Treat any short page as the last page
// (the true last page of a 3 996-listing feed has only 6 offers, well under 35).
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

export class GratkaScraper extends BaseScraper {
  // IMPORTANT: streaming disabled (despite prior `supportsStreaming = true`).
  // When streaming was on, the runner used the `onListing` callback path which
  // emits each listing as it's parsed from the search JSON-LD — but gratka's
  // detail-page enrichment (`_enrichNew`, which fetches photos / description /
  // coords / postedAt) was conditional on `!onListing` and so NEVER ran in
  // streaming mode. Result: every gratka listing persisted without coords,
  // without postedAt, with only 1 image (the JSON-LD `offer.image`) and the
  // short search description. Disabling streaming keeps peak memory slightly
  // higher (~5 MB for 1 050 listings × ~5 KB payload) but ensures the enrich
  // step actually runs. (Morizon has the same bug pattern; left for a future
  // B-task to fix in morizon.js.)
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'gratka', baseUrl: 'https://gratka.pl' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    const ads = [];
    const maxPages = pageLimit('GRATKA_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      // sort=newest → ADDED_AT DESC (newest-added first). Without this, gratka
      // defaults to REFRESHED_AT DESC (most-recently-refreshed first), which
      // mixes stale-but-recently-bumped listings into the top pages and breaks
      // any "stop early once we hit listings older than sinceTime" assumption.
      params.set('sort', 'newest');
      if (page > 1) params.set('page', String(page));
      if (filters.maxPrice != null) params.set('cena-calkowita:max', String(filters.maxPrice));
      if (filters.minPrice != null) params.set('cena-calkowita:min', String(filters.minPrice));
      const url = `${this.baseUrl}/nieruchomosci/mieszkania/${cityPath}/wynajem?${params.toString()}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true });
      } catch (e) {
        console.warn(`[gratka] fetch failed for ${city.slug} page ${page} (${e.message}), trying browser…`);
        try { html = await fetchRendered(url); }
        catch (e2) {
          console.error(`[gratka] browser fetch failed for ${city.slug} page ${page}:`, e2.message);
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[gratka] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
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
        if (page === 1) console.warn(`[gratka] ${city.slug}: no offers found on page 1`);
        else console.log(`[gratka] ${city.slug} page ${page}: empty page — stopping`);
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
        } catch {}
      }
      console.log(`[gratka] ${city.slug} page ${page}: ${offers.length} offers (total ${ads.length})`);
      if (offers.length < OFFERS_PER_PAGE) break; // short page = last page
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // Loads page 1 of gratka's search results (sort=newest) on the source's
  // persistent BrowserContext, parses JSON-LD's Product/AggregateOffer, and
  // returns `[{ externalId, postedAt, url, cityId }]` for each offer.
  //
  // postedAt is null here — gratka's search JSON-LD doesn't expose it (the
  // Nuxt payload does, but it's not in the search-page JSON-LD). The watcher
  // uses the ID hash for change detection (H2-T3) and short-circuits via the
  // last-seen-ID watermark (H2-T4) — postedAt is best-effort.
  async watchLatest(page, cities) {
    const out = [];
    for (const city of cities) {
      const cityPath = CITY_PATH[city.slug];
      if (!cityPath) continue;
      const params = new URLSearchParams();
      params.set('sort', 'newest');
      const url = `${this.baseUrl}/nieruchomosci/mieszkania/${cityPath}/wynajem?${params.toString()}`;
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
        console.warn(`[gratka] watcher fetch failed for ${city.slug}:`, e.message);
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

  // Per-listing detail fetch (Task I — H4 design). Same pattern as otodom's
  // `fetchOneListing` — fetch detail HTML, run the existing Nuxt-payload
  // extractors (extractNuxtPhotos / extractDetailDescription /
  // extractDetailCoords / extractDetailPostedAt / extractDetailStreet).
  // Price/rooms/area/floor aren't recoverable from the detail page alone
  // (they're in the JSON-LD `Product` block on the search page only);
  // left null, next full-cron will UPSERT the full data.
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    let html;
    try {
      html = await this._fetch(url, { desktop: true });
    } catch (e) {
      console.warn(`[gratka] fetchOneListing failed for ${url}:`, e.message);
      return null;
    }
    const nuxtPhotos = extractGratkaNuxtPhotos(html);
    const desc = extractDetailDescription(html);
    const coords = extractDetailCoords(html);
    const postedAt = extractDetailPostedAt(html);
    const street = extractDetailStreet(html);
    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: 'Pending enrichment',
      description: desc || '',
      price: 0,
      currency: 'PLN',
      rooms: null,
      area: null,
      floor: null,
      district: city.name_pl,
      street: street || null,
      address: street ? `${street}, ${city.name_pl}` : null,
      lat: coords?.lat || null,
      lng: coords?.lng || null,
      url,
      postedAt: postedAt || null,
      images: nuxtPhotos || [],
      conveniences: [],
      raw: {}
    };
  }

  // Search JSON-LD carries ONE photo per listing — fetch the detail pages of
  // new listings AND known listings with insufficient images.
  //
  // PHOTO-FETCH STRATEGY (Task A5 — verified 2026-08-29 on listing 48782533):
  // The gratka detail page server-renders only ~4 unique thumb URLs in its
  // visible carousel (cover + 3 gallery thumbs), even though the listing
  // advertises 8–20 photos in its meta description. The remaining photo URLs
  // are NOT loaded via a separate AJAX endpoint — the gratka /photos URL
  // pattern (`https://gratka.pl/.../ob/<id>/photos`) returns a 404 ("Pod
  // tym adresem nic nie ma..."), and the documented GraphQL/REST endpoints
  // (`https://gratka.pl/api-gratka`, `https://gratka.api.gratka.it/gratka/v2`)
  // are also 404 for direct listing-id lookups. Instead, all photo URLs are
  // embedded in the SAME detail-page HTML, inside the
  // `<script id="__NUXT_DATA__" type="application/json">` block, as a flat
  // JSON array of base64-encoded URLs. `extractGratkaNuxtPhotos` (in
  // jsonldProduct.js) walks that array's propertyData.photos[] chain,
  // decodes each entry's base64 `id`, and returns up to 20 full-res URLs.
  // Verified: returns 17/17 photos for the test listing (was 4 before A5).
  //
  // CONCURRENCY: gratka.js already uses a 4-worker Promise pool
  // (`ENRICH_CONCURRENCY = 4`) — this satisfies the "Promise pool of 4
  // when fetching many listing photo pages" requirement. No separate
  // /photos-page fetch is needed because all photo URLs come from the same
  // detail-page HTML that's already fetched for description/coords/postedAt
  // enrichment — saves one HTTP request per listing vs. the naive approach.
  //
  // STORAGE: photos are stored as URL strings only (no downloaded bytes) —
  // `persistListing` in base.js writes them to `listing_images.url` column.
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
    console.log(`[gratka] enriching ${fresh.length} listings (photos/desc/coords)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true });
          // Primary: gratka __NUXT_DATA__ payload — returns up to 20 full-res
          // URLs (verified 17/17 on test listing 48782533). Fallback: the
          // regex path (≤4 photos) if the Nuxt payload is missing (CF shell,
          // browser-rendered, morizon variant).
          const nuxtPhotos = extractGratkaNuxtPhotos(html);
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
          const postedAt = extractDetailPostedAt(html);
          if (postedAt) ad.postedAt = postedAt;
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }
}
