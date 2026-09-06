// Adresowo scraper — direct-owner listings (bez pośredników), server-rendered
// cards + detail-page enrichment for new listings (coords, photos, params).
//
// Warsaw inventory verified 2026-08-29 (Task B5): 1 133 listings across 11 pages
// — page 1 has 40 cards (intentional: newest + promoted batch), pages 2-10
// have 121 cards each, page 11 has 15 (last page). Pages 12+ wrap around to
// page 1's 40 cards (need short-page early-stop to avoid re-walking).
//
// URL pattern (Task B5 fix): /mieszkania-wynajem/<city>/_l<N>
//   - Page 1 MUST use /_l1 explicitly. Without the /_l1 suffix, adresowo
//     serves the NATIONAL feed (16 warsaw + 24 other cities mixed). With
//     /_l1 the city filter is applied and all 40 cards are warsaw-only.
//   - This was a pre-fix bug: the scraper used `/_l${page}` only for page > 1,
//     so page 1 always came back as the national feed and the slug filter
//     (href.startsWith('/o/mieszkanie-wynajem-<city>-')) had to discard ~60%
//     of cards. Fix: always use `/_l${page}` suffix, even for page 1.

import { BaseScraper } from './base.js';
import { fetchRendered } from '../browser.js';
import { many } from '../../db.js';

const SOURCE_ID = 3;
// 1 133 listings / 121-per-page ≈ 10 pages of full inventory. Cap at 30 to
// match B1/B2/B3 pattern parity — short-page early-stop (see OFFERS_PER_PAGE)
// will break the loop well before page 30 in practice (typically page 11).
// Bumped from 6 → 30 (Task B5): 6 pages captured only 6×121+40 ≈ 766 of 1 133
// listings (~67% of inventory); the wrap-around behaviour also meant pages
// 12+ silently re-walked page 1's 40 cards (wasted bandwidth + DB upserts).
const MAX_PAGES = 30;
// Page 1 is intentionally a 40-card batch (newest + promoted); pages 2-N
// are full 121-card batches. We use this only for the "short page" early-stop
// on pages > 1 (last-page signal) — never on page 1 itself.
//
// Pages can be off-by-one from natural inventory fluctuation (e.g. page 4
// returns 120 cards because one listing just got delisted). The short-page
// threshold uses HALF of OFFERS_PER_PAGE (~60) so a small fluctuation
// doesn't trigger a false break. The true last page returns ~15 cards,
// which is comfortably under 60.
const OFFERS_PER_PAGE = 121;
const SHORT_PAGE_THRESHOLD = Math.floor(OFFERS_PER_PAGE / 2); // ~60
// Stop paginating after this many consecutive fetch failures (transient 5xx,
// DNS, connection reset). Pre-fix a single failure did `break` and silently
// dropped pages 6..30 even though page 5 was the only one failing.
const MAX_CONSECUTIVE_FAILURES = 3;
const ENRICH_LIMIT = 200;
const ENRICH_CONCURRENCY = 3;

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

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseNum(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/&nbsp;/g, ' ').replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Best-effort postedAt extraction from the Polish "dodana X temu" string that
// adresowo embeds in a standalone <span class="block text-sm text-neutral-500
// lg:text-neutral-600">dodana …</span>. Returns null when no parseable signal
// is found (the runner then falls back to "not seen in previous run" detection
// via prevRunIds — same as the pre-fix behaviour).
//
// Mirrors B1's extractDetailPostedAt pattern (gratka Nuxt payload) and B2's
// createdAt extraction (otodom __NEXT_DATA__): populate postedAt so the
// runner can do accurate "new since previous cron run" detection. Without
// postedAt, the runner uses prevRunIds which is coarser and confounded by
// the global getSinceTime() bug (B8-#3).
function parsePostedAtFromText(text) {
  if (!text) return null;
  // Normalize Polish diacritics (ą→a, ć→c, ę→e, ł→l, ń→n, ó→o, ś→s, ż→z, ź→z)
  // so our regexes don't have to enumerate every accented variant. Mirrors
  // what gratka.js / otodom.js do implicitly via their JSON-LD payload.
  const t = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // "dzisiaj" / "wczoraj"
  if (/\bdzisiaj\b|\bdzis\b/.test(t)) return new Date(now);
  if (/\bwczoraj\b/.test(t)) return new Date(now - DAY);
  // "N dni temu" / "N dni"
  let m = t.match(/(\d+)\s*dni\s*temu/);
  if (m) return new Date(now - parseInt(m[1], 10) * DAY);
  // "N tygodni temu" (week = 7 days)
  m = t.match(/(\d+)\s*tygodni[e]?\s*temu/);
  if (m) return new Date(now - parseInt(m[1], 10) * 7 * DAY);
  // "ponad tydzień temu" — coarse: treat as 8 days (best-effort floor)
  if (/ponad\s*tydzien[e]?\s*temu/.test(t)) return new Date(now - 8 * DAY);
  // "ponad miesiąc temu" — coarse: treat as 31 days
  if (/ponad\s*miesiac\s*temu/.test(t)) return new Date(now - 31 * DAY);
  // "N miesięcy temu"
  m = t.match(/(\d+)\s*miesiecy\s*temu/);
  if (m) return new Date(now - parseInt(m[1], 10) * 30 * DAY);
  return null;
}

export class AdresowoScraper extends BaseScraper {
  // IMPORTANT: streaming disabled (Task B5 — same fix pattern as B1 gratka).
  // When `supportsStreaming = true`, the runner used the `onListing` callback
  // path, which emits each listing as it's parsed from the search cards — but
  // adresowo's detail-page enrichment (`_enrichNew`, which fetches photos /
  // description / coords / postedAt / params) was conditional on `!onListing`
  // and so NEVER ran in streaming mode. Result: every adresowo listing was
  // persisted with NO coords, NO postedAt, NO params, just 1 image (the card
  // cover thumbnail) and the short search-block description.
  // Disabling streaming keeps peak memory slightly higher (~5 MB for ~1 000
  // listings × ~5 KB payload) but ensures the enrich step actually runs.
  supportsStreaming = false;

  constructor() {
    super({ sourceId: SOURCE_ID, sourceSlug: 'adresowo', baseUrl: 'https://adresowo.pl' });
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, sinceTime = null, onListing = null } = options;

    const ads = [];
    const seenExternalIds = new Set();
    let seen = 0;
    const maxPages = pageLimit('ADRESOWO_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    for (let page = 1; page <= maxPages; page++) {
      // ALWAYS use /_l<N> suffix (even for page 1). Without /_l1 adresowo
      // serves the national feed instead of the city-filtered feed (pre-fix
      // bug — see file header).
      const params = new URLSearchParams();
      if (filters.maxPrice != null) params.set('fc', String(filters.maxPrice));
      const qs = params.toString();
      const url = `${this.baseUrl}/mieszkania-wynajem/${cityPath}/_l${page}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true });
      } catch (e) {
        console.warn(`[adresowo] ${city.slug} page ${page}: plain fetch failed (${e.message}), trying browser…`);
        try {
          html = await fetchRendered(url);
        } catch (e2) {
          consecutiveFailures++;
          console.error(`[adresowo] ${city.slug} page ${page}: browser fetch failed (${e2.message}); ${consecutiveFailures} consecutive failure(s)`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[adresowo] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`);
            break;
          }
          // Back off briefly so a transient 5xx / connection-reset blip
          // doesn't cascade into a hard abort and skip the remaining pages.
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }
      consecutiveFailures = 0; // reset on success

      const cards = this._parseCards(html, city, cityPath);
      if (!cards.length) {
        if (page === 1) console.warn(`[adresowo] ${city.slug}: no cards on page 1`);
        else console.log(`[adresowo] ${city.slug} page ${page}: empty page — stopping`);
        break;
      }

      // Wrap-around detection: adresowo pages 12+ silently serve the same 40
      // cards as page 1. Detect by counting how many of this page's cards
      // are already in the cumulative seenExternalIds set — if all of them
      // are dupes, we've wrapped around → break.
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
        `[adresowo] ${city.slug} page ${page}: ${cards.length} cards` +
        ` (new this page: ${cards.length - dupCount}, total ${seen})`
      );

      // Wrap-around signal: ALL cards on this page were duplicates of cards
      // we've already seen. Adresowo's pagination wraps page 1's 40 cards
      // onto pages 12+ — this break stops the wasted re-walk.
      if (cards.length > 0 && dupCount === cards.length) {
        console.log(`[adresowo] ${city.slug} page ${page}: 100% duplicates (wrap-around) — stopping`);
        break;
      }

      // Short-page early-stop: pages 2-N have 121 cards each (OFFERS_PER_PAGE);
      // the true last page returns ~15 (well under 60). Use HALF of
      // OFFERS_PER_PAGE as the threshold so a natural fluctuation of ±1-2
      // cards (e.g. page 4 returns 120 because a listing just got delisted)
      // doesn't trigger a false break. The wrap-around detection above
      // remains the primary signal for pages 12+ re-walking page 1's batch.
      if (page > 1 && cards.length < SHORT_PAGE_THRESHOLD) {
        console.log(`[adresowo] ${city.slug} page ${page}: short page (${cards.length} < ${SHORT_PAGE_THRESHOLD}) — stopping`);
        break;
      }

      // NB: no sinceTime early-termination here (unlike otodom/gratka). The
      // adresowo search cards don't expose a postedAt field at the page-scan
      // stage — postedAt is only backfilled by `_enrichNew` AFTER the page
      // walk finishes. So counting in-window items would always be 0 here
      // and trigger a false break on page 1. The runner falls back to the
      // prevRunIds check (source has no postedAt) for "new" detection.
    }

    if (!onListing) await this._enrichNew(ads);
    return onListing ? [] : ads;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // Loads page 1 of adresowo's search cards (`/_l1` suffix — B5 fix)
  // via the source's persistent BrowserContext, parses the offer cards
  // using the existing `_parseCards` helper, and returns
  // `[{ externalId, postedAt, url, cityId }]` per card.
  //
  // postedAt is null at this stage — adresowo cards don't expose the
  // posting date as a structured field, only as a Polish natural-language
  // string ("dodana X temu") which is parsed inside `_applyDetail`. The
  // watcher uses the ID hash for change detection (H2-T3) and the
  // last-seen-ID watermark short-circuit (H2-T4); postedAt is best-effort
  // and backfilled when `fetchOneListing` runs `_applyDetail` per-listing.
  async watchLatest(page, cities) {
    const out = [];
    for (const city of cities) {
      const cityPath = CITY_PATH[city.slug];
      if (!cityPath) continue;
      const url = `${this.baseUrl}/mieszkania-wynajem/${cityPath}/_l1`;
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
        console.warn(`[adresowo] watcher fetch failed for ${city.slug}:`, e.message);
        continue;
      }
      const cards = this._parseCards(html, city, cityPath);
      for (const c of cards) {
        out.push({
          externalId: String(c.externalId),
          postedAt: null,
          url: c.url,
          cityId: city.id
        });
      }
    }
    return out;
  }

  // Per-listing detail fetch (Task I — H4 design). Fetches the detail page
  // HTML, calls the existing `_applyDetail(html, ad)` to populate coords /
  // description / postedAt / images / params on a stub `ad` object.
  // Price/rooms/area/floor are already on the search card; since we don't
  // have the card here, those are left null/0 and the next full-cron run
  // will UPSERT the full data (the full cron runs `_parseCards` first to
  // get the card-level fields, then `_enrichNew` runs `_applyDetail` on
  // top).
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;
    const ad = { externalId: String(externalId), url, images: [], raw: {} };
    let html;
    try {
      html = await this._fetch(url, { desktop: true });
    } catch (e) {
      console.warn(`[adresowo] fetchOneListing fetch failed for ${url}:`, e.message);
      return null;
    }
    // Per-field try/catch — same pattern as the otodom fix (Task 4a). Each
    // branch logs on failure with the listing URL so missing-data patterns
    // are visible in the run log instead of being silently swallowed.
    try {
      this._applyDetail(html, ad);
    } catch (e) {
      console.warn(`[adresowo] _applyDetail threw for ${url}:`, e.message);
    }
    // Post-enrichment diagnostics: surface listings where extraction left
    // gaps so the run log shows which URLs to investigate. Previously the
    // silent `try {} catch {}` made missing data invisible.
    const gaps = [];
    if (!ad.description || ad.description.length < 50) gaps.push('desc');
    if (ad.lat == null || ad.lng == null) gaps.push('coords');
    if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
    if (gaps.length) {
      console.warn(`[adresowo] enrichment gap for ${url}: ${gaps.join(', ')}`);
    }
    return {
      externalId: String(externalId),
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: 'Pending enrichment',
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

  _parseCards(html, city, cityPath) {
    const out = [];
    const chunks = html.split('<div data-offer-card').slice(1);
    for (const chunk of chunks) {
      try {
        const card = chunk.slice(0, 8000);

        const idM = card.match(/data-id="(\d+)"/);
        const hrefM = card.match(/href="(\/o\/[^"]+)"/);
        const priceM = card.match(/font-bold">((?:[\d\s\u00a0]|&nbsp;)+)<\/span>\s*<span[^>]*>zł<\/span>/);
        if (!idM || !hrefM || !priceM) continue;

        const areaM = card.match(/font-bold">((?:[\d\s\u00a0,]|&nbsp;)+)<\/span>\s*<span[^>]*>m²<\/span>/);
        const roomsM = card.match(/font-bold">(\d+)<\/span><span[^>]*>\s*pok\.?<\/span>/);
        const imgM = card.match(/<img src="(https:\/\/s\d\.adresowa\.pl\/oi\/[^"]+)"/);
        const locM = card.match(/line-clamp-1 text-base leading-6 font-medium lg:text-sm">([^<]+)</);
        const streetM = card.match(/line-clamp-1 text-base leading-6 text-neutral-600 lg:text-sm">([^<]+)</);
        const descM = card.match(/<p class="mb-3 line-clamp-4[^"]*">([\s\S]*?)<\/p>/);

        const href = hrefM[1];
        // Belt-and-suspenders: even with the /_l1 fix, the page can still
        // mix in 1-2 cross-city "promoted" cards at the top. Keep the city-
        // slug filter so cross-city cards are never persisted.
        if (!href.startsWith(`/o/mieszkanie-wynajem-${cityPath}-`)) continue;

        const slugId = href.split('-').pop(); // base36 id at end of slug
        // Upgrade cover thumbnail to full-size xbig.jpg
        let coverUrl = imgM ? imgM[1] : null;
        if (coverUrl) {
          coverUrl = coverUrl.replace(/_cover@?\d*x?/i, '_xbig').replace(/\.webp$/i, '.jpg');
        }
        // location span is "Warszawa Ursynów" (city + district) — strip the city
        let district = locM ? stripTags(locM[1]) : '';
        district = district.replace(new RegExp('^' + city.name_pl + '\\s*', 'i'), '').trim() || city.name_pl;
        const street = streetM ? stripTags(streetM[1]) : null;
        const titleParts = [];
        titleParts.push(district);
        if (street) titleParts.push(street);
        const direct = !/przez agenta/i.test(card);

        out.push({
          externalId: slugId !== href ? slugId : idM[1],
          numericId: idM[1],
          sourceId: SOURCE_ID,
          cityId: city.id,
          title: titleParts.length ? `Mieszkanie — ${titleParts.join(', ')}` : 'Mieszkanie do wynajęcia',
          description: descM ? stripTags(descM[1]) : '',
          price: Math.round(parseNum(priceM[1]) || 0),
          currency: 'PLN',
          rooms: roomsM ? parseInt(roomsM[1]) : null,
          area: areaM ? parseNum(areaM[1]) : null,
          floor: null,
          district,
          street,
          address: titleParts.join(', '),
          lat: null,
          lng: null,
          url: this._normalizeUrl(`${this.baseUrl}${href}`),
          postedAt: null, // backfilled from detail page in _enrichNew ("dodana X temu" string)
          images: coverUrl ? [coverUrl] : [],
          conveniences: direct ? [{ type: 'direct', label: 'Bez pośredników' }] : [],
          raw: { url: href, direct }
        });
      } catch {}
    }
    return out.filter(a => a.price > 0 && a.externalId);
  }

  // Search cards carry only the cover thumbnail + a short 4-line description.
  // Fetch detail pages for listings that don't yet have ≥3 photos in the DB
  // so we can backfill: full description, coords (lat/lng), postedAt, params,
  // and the listing's own gallery photos (8-15 typical for Warsaw rent).
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
    console.log(`[adresowo] enriching ${fresh.length} listings (photos/desc/coords/postedAt/params)`);

    let idx = 0;
    const self = this;
    async function worker() {
      while (idx < fresh.length) {
        const ad = fresh[idx++];
        try {
          const html = await self._fetch(ad.url, { desktop: true });
          self._applyDetail(html, ad);
          // Per-listing gap diagnostics — same as fetchOneListing. Was a
          // silent `catch {}` before, masking all enrichment failures.
          const gaps = [];
          if (!ad.description || ad.description.length < 50) gaps.push('desc');
          if (ad.lat == null || ad.lng == null) gaps.push('coords');
          if (!ad.images || ad.images.length < 3) gaps.push(`imgs=${ad.images?.length || 0}`);
          if (gaps.length) console.warn(`[adresowo] _enrichNew gap for ${ad.url}: ${gaps.join(', ')}`);
        } catch (e) {
          console.warn(`[adresowo] _enrichNew failed for ${ad.url}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  _applyDetail(html, ad) {
    // ---- COORDINATES ----
    // Primary pattern: inline JS `re.geo.lat = 52.14; re.geo.lng = 21.04;`
    // Verified present on every adresowo detail page probed (Task 4b: 20/20
    // listings across warsaw/krakow/wroclaw/poznan all matched this regex).
    //
    // Fallbacks (defensive — in case adresowo ships a new page variant):
    //   1. JSON-LD `"latitude": X, "longitude": Y` (schema.org Place/GeoCoordinates)
    //   2. HTML data attributes `data-lat` / `data-lng`
    //   3. OpenGraph `og:latitude` / `og:longitude` meta tags
    // Each pattern is tried in order; the first to yield BOTH lat and lng wins.
    try {
      let lat = null, lng = null;
      const latM = html.match(/re\.geo\.lat\s*=\s*(-?[\d.]+)/);
      const lngM = html.match(/re\.geo\.lng\s*=\s*(-?[\d.]+)/);
      if (latM) lat = parseFloat(latM[1]);
      if (lngM) lng = parseFloat(lngM[1]);
      if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) {
        // Fallback 1: JSON-LD
        const ldLatM = html.match(/"latitude"\s*:\s*(-?[\d.]+)/);
        const ldLngM = html.match(/"longitude"\s*:\s*(-?[\d.]+)/);
        if (ldLatM && ldLngM) {
          const la = parseFloat(ldLatM[1]), ln = parseFloat(ldLngM[1]);
          if (isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
            lat = la; lng = ln;
          }
        }
      }
      if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) {
        // Fallback 2: data-lat / data-lng
        const dlLatM = html.match(/data-lat=["'](-?[\d.]+)/);
        const dlLngM = html.match(/data-lng=["'](-?[\d.]+)/);
        if (dlLatM && dlLngM) {
          const la = parseFloat(dlLatM[1]), ln = parseFloat(dlLngM[1]);
          if (isFinite(la) && isFinite(ln)) { lat = la; lng = ln; }
        }
      }
      if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) {
        // Fallback 3: og:latitude / og:longitude meta tags (try both attr orders)
        const ogLatM = html.match(/<meta\s+(?:property|name)=["']og:latitude["'][^>]*content=["'](-?[\d.]+)/i) ||
                       html.match(/<meta\s+content=["'](-?[\d.]+)["'][^>]*(?:property|name)=["']og:latitude["']/i);
        const ogLngM = html.match(/<meta\s+(?:property|name)=["']og:longitude["'][^>]*content=["'](-?[\d.]+)/i) ||
                       html.match(/<meta\s+content=["'](-?[\d.]+)["'][^>]*(?:property|name)=["']og:longitude["']/i);
        if (ogLatM && ogLngM) {
          const la = parseFloat(ogLatM[1]), ln = parseFloat(ogLngM[1]);
          if (isFinite(la) && isFinite(ln)) { lat = la; lng = ln; }
        }
      }
      if (lat != null && lng != null && isFinite(lat) && isFinite(lng)) {
        ad.lat = lat;
        ad.lng = lng;
      }
    } catch (e) {
      console.warn('[adresowo] _applyDetail coords extraction threw:', e.message);
    }

    // ---- DESCRIPTION ----
    // <p id="description" class="...">full Polish description with <br/> + <a> links</p>
    // Only overwrite if the cleaned text is longer than what we already have
    // (search-card preview sometimes has 4 lines of desc that we keep as fallback).
    try {
      const descM = html.match(/<p\s+id=["']description["'][^>]*>([\s\S]*?)<\/p>/);
      if (descM) {
        const d = stripTags(descM[1]);
        if (d.length > (ad.description || '').length) ad.description = d;
      }
    } catch (e) {
      console.warn('[adresowo] _applyDetail description extraction threw:', e.message);
    }

    // ---- POSTED AT ----
    // Best-effort from the Polish "dodana X temu" string that adresowo embeds
    // in a standalone <span class="block text-sm text-neutral-500
    // lg:text-neutral-600">dodana … [i zaktualizowana Y temu]</span>. Coarse:
    // "dzisiaj", "wczoraj", "N dni temu", "ponad tydzień temu". Returns null
    // if no parseable signal → runner falls back to "not seen in previous
    // run" detection. Note: we strip the optional "i zaktualizowana …"
    // suffix so we parse the ADDED date, not the UPDATED date.
    try {
      if (!ad.postedAt) {
        const ageM = html.match(/>\s*(dodana[^<\n]{0,80}?)\s*</);
        if (ageM) {
          const addedText = ageM[1].split(/\s+i\s+zaktualizowana/i)[0];
          const parsed = parsePostedAtFromText(addedText);
          if (parsed) ad.postedAt = parsed;
        }
      }
    } catch (e) {
      console.warn('[adresowo] _applyDetail postedAt extraction threw:', e.message);
    }

    // ---- PHOTOS ----
    // Comprehensive capture of every image URL on s1/s2/...adresowa.pl/oi/
    // (the only photo CDN adresowo uses for listing images — verified across
    // 5 sample listings in Task 4b: 100% of gallery URLs match this pattern,
    // 0 use other hosts). The regex is intentionally broad (any image
    // extension, any path under /oi/) so future CDN layout changes don't
    // silently break photo extraction.
    //
    // Pre-fix bug (Task B5): the filter was
    //   `.filter(u => u.includes(core) || u.includes('adresowa.pl/oi/'))`
    // but `core` was derived from the listing URL slug (which has a
    // `wynajem-` prefix the image URLs lack), so `u.includes(core)` was
    // always FALSE, and the `||` clause matched EVERY image on the page
    // (sidebar/related listings included). 12 of 21 captured URLs were
    // sidebar photos from OTHER listings.
    //
    // Fix (B5): use og:image to identify the listing's own 6-hex photo
    // prefix (e.g. "4015ce" in /oi/2a/43/4015ce_779e_xbig.jpg), then filter
    // by `/<6-hex>_<4-hex>/` matching that prefix.
    //
    // Task 4b robustness: try BOTH attribute orders for og:image (property
    // before content, content before property) — adresowo uses the former
    // but the swapped form has appeared on A/B-tested page variants.
    try {
      const ogM = html.match(/<meta\s+property=["']og:image["'][^>]*content=["'](https:\/\/s\d\.adresowa\.pl\/oi\/[^"]+)["']/i) ||
                  html.match(/<meta\s+content=["'](https:\/\/s\d\.adresowa\.pl\/oi\/[^"]+)["'][^>]*property=["']og:image["']/i);
      let selfPrefix = null;
      if (ogM) {
        const pm = ogM[1].match(/\/oi\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{6})_[0-9a-f]{4}/);
        if (pm) selfPrefix = pm[1];
      }
      // Capture every /oi/ image URL (jpg/webp/png/avif). When selfPrefix is
      // known, filter to only this listing's photos (avoids sidebar bleed).
      // When og:image is missing (defensive — shouldn't happen on real
      // detail pages), keep all URLs and rely on dedupe-by-hash to clean up.
      const allImgs = [...html.matchAll(/https:\/\/s\d\.adresowa\.pl\/oi\/[^"'\s\\]+?\.(?:jpg|jpeg|webp|png|avif)/g)]
        .map(m => m[0])
        .filter(u => !selfPrefix || new RegExp(`/${selfPrefix}_`).test(u));
      // Dedupe by hash prefix (e.g. "3fb300_7a2b"). The same photo appears
      // multiple times on the page (og:image, gallery, JSON-LD, canonical),
      // so this dedup is essential — without it 50+ URLs collapse to ~10
      // photos but the slice(0, 12) keeps 12 unrelated entries.
      // Size priority: _xbig > _big > _cover > _small.
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
      if (uniq.length) ad.images = uniq.slice(0, 12);
    } catch (e) {
      console.warn('[adresowo] _applyDetail image extraction threw:', e.message);
    }

    // ---- PARAMS ----
    // <span class="block lg:font-semibold">LABEL</span> <span ...>VALUE</span>
    try {
      const params = [];
      for (const m of html.matchAll(/<span class="block lg:font-semibold">([^<]{2,60})<\/span>\s*<span class="block text-sm text-neutral-500 lg:text-neutral-600">([^<]{1,120})<\/span>/g)) {
        params.push({ key: stripTags(m[1]), name: stripTags(m[1]), value: stripTags(m[2]) });
      }
      if (params.length) ad.raw.params = params.slice(0, 20);
    } catch (e) {
      console.warn('[adresowo] _applyDetail params extraction threw:', e.message);
    }
  }

  // Strip tracking/marketing query params so the same ad always produces the
  // same stored URL. Adresowo's listing URLs are clean by default (no utm_*
  // in the /o/mieszkanie-wynajem-… path), but normalizing defensively
  // protects against future regressions and against imported URLs with
  // utm_*/fbclid etc. Mirrors B2-5 (otodom) and B3-11 (olx).
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
