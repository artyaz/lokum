// Allegro.pl nieruchomości scraper — REST API (developer.allegro.pl).
//
// WHY REST API (not HTML scraping):
//   Allegro.pl is the most aggressive anti-bot target in Poland (enterprise-
//   grade bot detection — custom JS, behavioral fingerprinting, CAPTCHA on
//   suspicious traffic). HTML scraping via plain fetch() or Playwright is
//   not viable. Instead we go through Allegro's official REST API at
//   https://developer.allegro.pl, which is the canonical data source the
//   allegro.pl front-end itself uses.
//
// AUTH FLOW (OAuth2 client_credentials grant):
//   1. Register an application at https://developer.allegro.pl — get a
//      CLIENT_ID + CLIENT_SECRET pair (env vars ALLEGRO_CLIENT_ID and
//      ALLEGRO_CLIENT_SECRET).
//   2. POST https://allegro.pl/auth/oauth/token?grant_type=client_credentials
//      with HTTP Basic auth header (Basic base64(client_id:client_secret)).
//   3. Response: { access_token, token_type: "Bearer", expires_in: 43200,
//      scope, jti }. The TTL is 43 200 s = 12 h. We cache the token in
//      memory for 11 h (safety margin) and refresh lazily.
//   4. For every API call: `Authorization: Bearer <access_token>` +
//      `Accept: application/vnd.allegro.public.v1+json` (Allegro's official
//      versioned content type).
//
// SEARCH ENDPOINT:
//   GET https://api.allegro.pl/offers/listing
//     ?category.id=112745         (Mieszkania do wynajęcia — all Poland)
//     &location.city.id=110009    (Warszawa)
//     &limit=60                   (Allegro API hard cap on page size)
//     &offset=0                   (paginated by offset+limit)
//   Returns: {
//     items: {
//       promoted: [...],          (promoted listings — bumped to top of every
//                                  page; their stable ids dedupe via the
//                                  (source_id, external_id) UNIQUE upsert)
//       regular:  [...],          (organic listings — ordered by recency)
//     },
//     searchMeta: { totalElements, availableElements, offset, limit },
//     nextPage: "https://api.allegro.pl/offers/listing?...&offset=60"
//   }
//
//   Each item shape (per Allegro public-API OpenAPI schema):
//     {
//       id, name,                             ← external id + title
//       images: [{ url, contentType }],       ← photos (8-12 typical)
//       sellingMode: {
//         format: "BUY_NOW",
//         price: { amount: "3500.00", currency: "PLN" },
//         previewPrice: { amount, currency },
//         popularity: 0
//       },                                   ← price (PLN, monthly rent)
//       parameters: [
//         { id: "127662", name: "Powierzchnia",
//           values: ["48.5"], valuesLabel: ["48.5"], unit: "m²" },
//         { id: "127648", name: "Liczba pokoi",
//           values: ["2"], valuesLabel: ["2"] },
//         { id: "127649", name: "Piętro",
//           values: ["3"], valuesLabel: ["3"] },
//         { id: "127650", name: "Liczba pięter", ... },
//         { id: "127654", name: "Rodzaj budynku", ... },
//         { id: "127651", name: "Rynek", ... },
//         ...
//       ],                                   ← area / rooms / floor etc.
//       location: {
//         city:    { id, name },             ← always Warszawa for our query
//         region:  { id, name },             ← "mazowieckie"
//         country: "PL"
//       },                                   ← no lat/lng (Allegro doesn't
//                                              expose geo-coords on offers;
//                                              enrich.js reverse-geocodes
//                                              from district/city)
//       category: { id },
//       seller:  { id, login, company },
//       publication: {
//         status:    "ACTIVE",
//         startedAt: "2026-08-29T10:00:00Z",  ← earliest available "posted"
//         endingAt:  "2026-09-28T12:00:00Z"
//       },
//       delivery: { availableForFree, ... },
//       taxInfo:  { vat: true }
//     }
//
// PER-LISTING DESCRIPTION:
//   The /offers/listing response does NOT include the description field —
//   only the offer's `name` (title) and parameters. To meet the quality bar
//   ("description: full Polish text") we fetch each offer's full data via:
//     GET https://api.allegro.pl/offers/{offerId}
//   This endpoint returns `{ description, ... }` with the full Polish text.
//   The fetch is best-effort: 403/429/404 → log + leave description as the
//   offer's `name` fallback. We cap at ENRICH_LIMIT listings per fetch cycle
//   (default 300) and use a 4-worker pool (mirrors the gratka/no pattern).
//
// !!! IMPORTANT — VERIFICATION REQUIREMENT !!!
//   As of 2025-03-15, Allegro requires an application to be "verified"
//   before it can call /offers/listing. New apps get HTTP 403 with
//   `{ "errors": [{ "code": "VerificationRequired", "message": "Access
//   is denied. Verification is required." }] }`. As of 2025-09-22 Allegro
//   has SUSPENDED verification for new apps for business reasons (per
//   https://github.com/allegro/allegro-api/issues/12257). The scraper
//   handles the 403 gracefully (logs a clear actionable warning + returns
//   [] for that cycle) and will start returning data the moment the
//   operator's application gets verified.
//
// Quality bar (per Task D brief):
//   - Photos: 8-12 from `images[]` — capped at 20 by persistListing.
//   - Description: full Polish text from per-listing /offers/{id} call.
//   - Price: PLN/monthly from `sellingMode.price.amount` (rounded to int).
//   - Location: Allegro does NOT expose lat/lng on offers. We leave
//     lat/lng null here; enrich.js reverse-geocodes from district/city
//     (same pattern as telegram.js). District is parsed from the offer's
//     `location.city.name` (= "Warszawa" for all our Warsaw-scoped results)
//     or, when available, from `location.cityDistrict.name` (returned by
//     the per-listing /offers/{id} call for some listings).
//   - Rooms/area/floor from `parameters[]` (matched by Polish name).

import { BaseScraper } from './base.js';

const SOURCE_ID = 21;

// Walk up to 30 pages × 60 offers = ~1 800 offers/city per fetch cycle.
// Pairs with the 3×/day schedule so each fetch catches everything added
// in the past ~8h with margin to spare. Env-overridable via ALLEGRO_MAX_PAGES.
const MAX_PAGES = 30;
// Allegro API hard cap on `limit` is 60 offers per page.
const PAGE_LIMIT = 60;
// Per-listing detail fetches (description) — capped at 300 per fetch cycle
// to keep memory bounded + avoid hammering the API. Same value as no.js.
const ENRICH_LIMIT = 300;
const ENRICH_CONCURRENCY = 4;
// Stop walking pages after this many consecutive fetch failures — same
// pattern as no/gratka/olx/rentola/telegram (transient 5xx, network blip).
// 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// Polite delay between page fetches — we're hitting the same API gateway
// repeatedly for paginated walks. 400 ms/page × 30 pages = ~12 s extra
// pacing per city per fetch cycle.
const REQUEST_DELAY_MS = 400;
// Token TTL safety margin: refresh 1h before the 12h deadline to avoid
// making API calls with a token that expires mid-walk.
const TOKEN_REFRESH_LEAD_MS = 60 * 60 * 1000;

// Allegro category IDs (verified via allegro.pl search-result URLs):
//   112745 = "Mieszkania do wynajęcia" (rental apartments — all Poland)
//   117037 = "Mieszkania do wynajęcia Warszawa" (Warsaw-specific scoped
//            category — equivalent to passing category.id=112745 +
//            location.city.id=110009; we use the latter for clarity).
const CATEGORY_MIESZKANIA_WYNAJEM = '112745';

// Allegro location.city.id values (verified via research notes; Allegro's
// taxonomy is hierarchical województwo → miasto → dzielnica, with 6-digit
// IDs). Only Warszawa (110009) is currently configured — Allegro doesn't
// expose a clean public listing of city IDs, so other cities would require
// scraping the allegro.pl category tree to discover their IDs. The scraper
// no-ops for unconfigured cities (same pattern as telegram.js).
const CITY_INFO = {
  warsaw: { cityId: '110009' }
};

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Polish/Slavic number parse — accepts "2 500", "2 500,50", "2500",
// "2.500" (Polish thousand sep). Spaces and \u00A0 (NBSP) are stripped.
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v)
    .replace(/[\s\u00A0]/g, '')
    // Strip Polish thousand-sep "." in 3-digit groups, keep "." as decimal
    // only when followed by 1-2 digits at the end of the string.
    .replace(/(\d)\.(\d{3})/g, '$1$2')
    .replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Module-level token cache so multiple AllegroScraper instances (full cron
// + always-on watcher, when wired up) share the same OAuth2 token. The
// cache holds `{ token, expiresAt }` — `expiresAt` is a Date ms-timestamp
// pre-shifted by TOKEN_REFRESH_LEAD_MS so the consumer just checks
// `Date.now() >= expiresAt`.
let _tokenCache = null;

export class AllegroScraper extends BaseScraper {
  // Streaming disabled — same reason as nieruchomosciOnline/telegram: the
  // post-search enrichment step (per-listing /offers/{id} fetch for the
  // full description) needs to run AFTER the search walk, and the
  // streaming `onListing` path skips enrichment. We retain the listings
  // array (~5 MB for ~1 800 listings × ~3 KB payload) and then run the
  // 4-worker detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'allegro',
      baseUrl: 'https://allegro.pl'
    });
    // Allegro REST API base — distinct from the public HTML base_url.
    this._apiBase = 'https://api.allegro.pl';
    this._authBase = 'https://allegro.pl';
  }

  // Public entry point. Walks /offers/listing for the given city, then
  // enriches the first ENRICH_LIMIT listings with the full description
  // from /offers/{id}. Returns the normalized listings array.
  async fetchCity(city, options = {}) {
    const info = CITY_INFO[city.slug];
    if (!info) return [];
    const { filters = {}, sinceTime = null } = options;

    // Step 1: get OAuth2 bearer token (cached for ~11h).
    let token;
    try {
      token = await this._getToken();
    } catch (e) {
      console.error(
        `[allegro] ${city.slug}: OAuth2 token fetch failed: ${e.message}.`,
        `Set ALLEGRO_CLIENT_ID + ALLEGRO_CLIENT_SECRET env vars`,
        `(see .env.example). Returning [].`
      );
      return [];
    }

    // Step 2: walk /offers/listing paginated.
    const ads = [];
    const maxPages = envInt('ALLEGRO_MAX_PAGES', MAX_PAGES);
    let consecutiveFailures = 0;
    let totalElements = null;
    let verificationFailed = false;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * PAGE_LIMIT;
      const params = new URLSearchParams();
      params.set('category.id', CATEGORY_MIESZKANIA_WYNAJEM);
      params.set('location.city.id', info.cityId);
      params.set('limit', String(PAGE_LIMIT));
      params.set('offset', String(offset));

      const url = `${this._apiBase}/offers/listing?${params.toString()}`;

      let json;
      try {
        json = await this._fetchApiJson(url, token);
        consecutiveFailures = 0;
      } catch (e) {
        // Detect the "VerificationRequired" 403 — this is the most likely
        // failure for a newly registered application. Log a single clear
        // actionable warning + abort the walk. The cron will retry next
        // cycle; once the operator gets verified, the data will flow.
        if (e.allegroVerificationRequired) {
          console.error(
            `[allegro] ${city.slug}: HTTP 403 VerificationRequired —`,
            `the /offers/listing endpoint requires a VERIFIED Allegro`,
            `application. As of 2025-09-22 Allegro has suspended verification`,
            `for new apps (see https://github.com/allegro/allegro-api/issues/12257).`,
            `Contact Allegro support to request verification. Aborting walk.`
          );
          verificationFailed = true;
          break;
        }
        consecutiveFailures++;
        console.warn(
          `[allegro] ${city.slug} page ${page + 1}: API fetch failed:`,
          e.message, `(consecutive #${consecutiveFailures})`
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[allegro] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive`,
            `failures, aborting walk at page ${page + 1}`
          );
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      // Allegro splits items into `promoted` (bumped to top of every page —
      // their stable ids dedupe via the (source_id, external_id) UNIQUE
      // upsert in persistListing) and `regular` (organic, ordered by
      // recency). We concatenate both, regular first (since promoted ones
      // rotate and shouldn't displace organic ordering for the sinceTime
      // early-exit).
      const items = [
        ...(json.items?.regular || []),
        ...(json.items?.promoted || [])
      ];
      if (!items.length) {
        console.log(
          `[allegro] ${city.slug} page ${page + 1}: no items, stopping`
        );
        break;
      }

      if (totalElements === null) {
        totalElements = json.searchMeta?.totalElements ?? null;
      }

      let processedOnPage = 0;
      let inWindow = 0;
      for (const ad of items) {
        try {
          const l = this._normalize(ad, city);
          if (!l) continue;
          processedOnPage++;
          if (sinceTime && l.postedAt && new Date(l.postedAt) >= sinceTime) {
            inWindow++;
          }
          ads.push(l);
        } catch {
          // skip broken ad
        }
      }
      console.log(
        `[allegro] ${city.slug} page ${page + 1}: ${processedOnPage} offers`,
        `(total ${ads.length}` +
        (sinceTime ? `, ${inWindow} newer than sinceTime` : '') + ')'
      );

      // Early-termination: if nothing on this page is newer than sinceTime,
      // the next page can only contain older offers — safe to stop.
      if (sinceTime && processedOnPage > 0 && inWindow === 0) {
        console.log(
          `[allegro] ${city.slug} page ${page + 1}: no in-window offers,`,
          `stopping early`
        );
        break;
      }

      // Stop if we've drained the result set the API is willing to return.
      if (totalElements && offset + items.length >= totalElements) {
        console.log(
          `[allegro] ${city.slug} reached API totalElements cap`,
          `(${totalElements})`
        );
        break;
      }

      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }

    if (verificationFailed) return [];

    // Step 3: enrich the first ENRICH_LIMIT listings with full Polish
    // description from per-listing /offers/{id} call.
    if (ads.length) await this._enrichNew(ads, { sinceTime });

    return ads;
  }

  // ==========================================================================
  // OAuth2 token management.
  // ==========================================================================

  async _getToken() {
    // Refresh 1h before expiry.
    if (_tokenCache && Date.now() < _tokenCache.expiresAt - TOKEN_REFRESH_LEAD_MS) {
      return _tokenCache.token;
    }
    const clientId = process.env.ALLEGRO_CLIENT_ID;
    const clientSecret = process.env.ALLEGRO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET env vars not set'
      );
    }
    // Allegro's OAuth2 token endpoint is on the *auth* subdomain
    // (https://allegro.pl/auth/oauth/token), NOT on api.allegro.pl.
    const url = `${this._authBase}/auth/oauth/token?grant_type=client_credentials`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${r.statusText} ${body.slice(0, 200)}`);
      }
      const json = await r.json();
      if (!json.access_token) {
        throw new Error(`no access_token in response: ${JSON.stringify(json).slice(0, 200)}`);
      }
      const ttlSec = Number(json.expires_in) || 43200;
      _tokenCache = {
        token: json.access_token,
        expiresAt: Date.now() + ttlSec * 1000
      };
      console.log(
        `[allegro] OAuth2 token acquired (TTL ${ttlSec}s,`,
        `expires ${new Date(_tokenCache.expiresAt).toISOString()})`
      );
      return _tokenCache.token;
    } finally {
      clearTimeout(t);
    }
  }

  // ==========================================================================
  // HTTP helpers.
  // ==========================================================================

  // GET an Allegro API endpoint as JSON with the bearer token. Detects the
  // 403 VerificationRequired error specifically (raised as
  // `allegroVerificationRequired=true` on the thrown Error so callers can
  // surface the actionable warning instead of retrying).
  async _fetchApiJson(url, token, { timeout = 15000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.allegro.public.v1+json',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
        },
        signal: controller.signal
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        // Allegro's standard 403 VerificationRequired error body:
        //   { "errors": [{ "code": "VerificationRequired",
        //     "message": "Access is denied. Verification is required." }] }
        const isVerification = r.status === 403 &&
          /VerificationRequired/i.test(body);
        const e = new Error(
          `HTTP ${r.status} ${r.statusText} ${body.slice(0, 200)}`
        );
        if (isVerification) e.allegroVerificationRequired = true;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ==========================================================================
  // Normalization — map one Allegro offer item to our normalized listing.
  // ==========================================================================

  _normalize(ad, city) {
    if (!ad || !ad.id) return null;
    const title = String(ad.name || '').trim();
    if (!title) return null;

    // Price — from sellingMode.price.amount (the canonical offer price).
    // Fallback to sellingMode.previewPrice.amount (a different field used
    // when the offer is in auction mode). Both are decimal strings in PLN.
    const priceRaw =
      ad.sellingMode?.price?.amount ??
      ad.sellingMode?.previewPrice?.amount ??
      null;
    const price = parseNum(priceRaw);
    if (!price || price <= 0) return null;

    // Parameters — matched by Polish display name (stable; numeric IDs
    // have changed across API versions).
    const params = Array.isArray(ad.parameters) ? ad.parameters : [];
    const findParam = (nameRe) =>
      params.find(p => nameRe.test(String(p?.name || '')));

    const areaParam = findParam(/powierzchnia/i);
    const area = areaParam
      ? parseNum(Array.isArray(areaParam.values) ? areaParam.values[0] : areaParam.valuesLabel?.[0])
      : null;

    const roomsParam = findParam(/liczba pokoi|pokoje/i);
    const rooms = roomsParam
      ? parseNum(Array.isArray(roomsParam.values) ? roomsParam.values[0] : roomsParam.valuesLabel?.[0])
      : null;

    const floorParam = findParam(/pi[eę]tro/i);
    // Avoid matching "Liczba pięter" (total floors) — restrict to the
    // bare "Piętro" name. Allegro names are exact, but defensive regex.
    const floorExact = params.find(p =>
      /^\s*pi[eę]tro\s*$/i.test(String(p?.name || ''))
    );
    const floorSrc = floorExact || floorParam;
    const floorRaw = floorSrc
      ? (Array.isArray(floorSrc.values) ? floorSrc.values[0] : floorSrc.valuesLabel?.[0])
      : null;
    const floor = this._normalizeFloor(floorRaw);

    // Photos — Allegro returns `images[]` with full URLs. Take up to 12
    // (quality bar minimum; persistListing caps at 20). We slice BEFORE
    // deduping to preserve the seller's chosen photo order (the first
    // photo is the cover).
    const images = (ad.images || [])
      .map(img => (typeof img === 'string' ? img : img?.url))
      .filter(Boolean);
    const seen = new Set();
    const dedupedImages = [];
    for (const u of images) {
      if (seen.has(u)) continue;
      seen.add(u);
      dedupedImages.push(u);
      if (dedupedImages.length >= 12) break;
    }

    // Location — Allegro location has city + region but NOT lat/lng. The
    // per-listing /offers/{id} call MAY expose `location.cityDistrict.name`
    // for some Warsaw listings (we'll set ad.district in _enrichNew when
    // available). Until then, default to city.name (= "Warszawa").
    const loc = ad.location || {};
    const district = loc.city?.name || city.name_pl;
    const address = [loc.city?.name, loc.region?.name].filter(Boolean).join(', ')
      || district;

    // postedAt — use publication.startedAt (when the offer was first
    // published). Fall back to publication.endingAt - 30 days (Allegro's
    // default offer duration is 30d) when startedAt is missing.
    let postedAt = null;
    if (ad.publication?.startedAt) {
      const d = new Date(ad.publication.startedAt);
      if (!isNaN(d.getTime())) postedAt = d;
    } else if (ad.publication?.endingAt) {
      const d = new Date(ad.publication.endingAt);
      if (!isNaN(d.getTime())) d.setDate(d.getDate() - 30);
      postedAt = d;
    }

    // URL — Allegro offer URL is https://allegro.pl/oferta/<slug>-<id>.
    // The listing response doesn't always include a slug, so we fall back
    // to the bare /oferta/<id> form (Allegro redirects on slug mismatch).
    const offerUrl = ad.url
      ? (ad.url.startsWith('http') ? ad.url : `${this.baseUrl}${ad.url}`)
      : `${this.baseUrl}/oferta/${ad.id}`;

    return {
      externalId: String(ad.id),
      sourceId: SOURCE_ID,
      cityId: city.id,
      title: this._cleanText(title),
      description: this._cleanText(title),  // placeholder — enriched below
      price: Math.round(price),
      currency: 'PLN',
      rooms: rooms != null ? Math.round(rooms) : null,
      area,
      floor,
      district,
      street: null,  // Allegro doesn't expose street — only city/region
      address,
      lat: null,      // Allegro API does not expose lat/lng — enrich.js
                      // reverse-geocodes from district/city.
      lng: null,
      url: this._normalizeUrl(offerUrl),
      postedAt,
      images: dedupedImages,
      conveniences: this._inferConveniences(ad, params),
      raw: {
        id: ad.id,
        name: ad.name,
        category: ad.category,
        sellingMode: ad.sellingMode,
        parameters: params,
        location: loc,
        seller: ad.seller,
        publication: ad.publication
      }
    };
  }

  // Normalize Allegro's "Piętro" parameter value to our `floor` field.
  // Possible values: "1".."10", "parterowy" / "parter" (ground floor),
  // "powyżej 10" (> 10). Returns a string to match the rest of the
  // scrapers (e.g. gratka stores "3/5" — Allegro only has the floor
  // number, not total).
  _normalizeFloor(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    if (!s) return null;
    if (/^(parter|parterowy|ground)$/.test(s)) return '0';
    if (/powy/.test(s)) {
      // "powyżej 10" — extract the digit if present, else keep raw.
      const m = s.match(/\d+/);
      return m ? `>${m[0]}` : s;
    }
    const n = parseNum(s);
    if (n != null && n >= 0 && n <= 200) return String(n);
    return s;
  }

  // Infer conveniences from `parameters[]` + description text. Allegro's
  // apartment category surfaces: "Rodzaj budynku" (building type),
  // "Dodatkowa powierzchnia" (extra space — balcony/garden), "Wyposażenie"
  // (furniture), and various others. We map the common ones.
  _inferConveniences(ad, params) {
    const conv = [];
    const desc = String(ad.name || '').toLowerCase();
    const extras = params.find(p => /dodatkowa\s*powierzchnia/i.test(String(p?.name || '')));
    if (extras && Array.isArray(extras.values)) {
      for (const v of extras.values) {
        const s = String(v || '').toLowerCase();
        if (/balkon/i.test(s)) conv.push({ type: 'balcony', label: 'Balkon' });
        if (/ogr[oó]dek|taras/i.test(s)) conv.push({ type: 'garden', label: 'Ogródek/Taras' });
        if (/gara/.test(s)) conv.push({ type: 'garage', label: 'Garaż' });
      }
    }
    const btype = params.find(p => /rodzaj\s*budynku/i.test(String(p?.name || '')));
    if (btype && Array.isArray(btype.values)) {
      const v = String(btype.values[0] || '').toLowerCase();
      if (/blok|apartament/i.test(v)) conv.push({ type: 'building', label: `Budynek: ${btype.values[0]}` });
    }
    const furniture = params.find(p => /umeblowan|wyposa/.test(String(p?.name || '')));
    if (furniture && Array.isArray(furniture.values)) {
      const v = String(furniture.values[0] || '').toLowerCase();
      if (/tak|yes|full|część|partial/i.test(v)) {
        conv.push({ type: 'furniture', label: `Umeblowane: ${furniture.values[0]}` });
      }
    }
    // Best-effort text scan for nearby POIs in the offer name.
    if (/\bmetro\b/.test(desc)) conv.push({ type: 'transport', label: 'Metro nearby' });
    if (/\b(biedronka|lidl|zabka|carrefour|auchan|kaufland)\b/.test(desc)) {
      const m = desc.match(/\b(biedronka|lidl|zabka|carrefour|auchan|kaufland)\b/);
      if (m) conv.push({ type: 'market', label: `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} nearby` });
    }
    if (/\b(park|skwer|las)\b/.test(desc)) {
      conv.push({ type: 'park', label: 'Park nearby' });
    }
    return conv.slice(0, 5);
  }

  // ==========================================================================
  // Per-listing enrichment — fetch full Polish description from
  // GET /offers/{offerId}. The /offers/listing endpoint does NOT include
  // description text. Best-effort: 4-worker pool, ENRICH_LIMIT cap.
  // ==========================================================================

  async _enrichNew(ads, { sinceTime = null } = {}) {
    if (!ads.length) return;
    const toEnrich = ads.slice(0, ENRICH_LIMIT);
    let idx = 0;
    let okCount = 0;
    let failCount = 0;
    let token;
    try {
      token = await this._getToken();
    } catch (e) {
      console.warn(
        `[allegro] enrich skipped (no token): ${e.message}`,
        `— listings will be persisted with title as placeholder description`
      );
      return;
    }
    console.log(
      `[allegro] enriching ${toEnrich.length}/${ads.length} listings with`,
      `full description from /offers/{id} (concurrency ${ENRICH_CONCURRENCY})`
    );
    const self = this;
    async function worker() {
      while (idx < toEnrich.length) {
        const ad = toEnrich[idx++];
        try {
          const url = `${self._apiBase}/offers/${encodeURIComponent(ad.externalId)}`;
          const json = await self._fetchApiJson(url, token, { timeout: 15000 });
          // Description — Allegro returns full Polish text in `description`.
          if (json.description && String(json.description).length > ad.description.length) {
            ad.description = self._cleanText(String(json.description));
          }
          // District — Allegro's per-offer location may include
          // `cityDistrict.name` (e.g. "Mokotów") for Warsaw listings.
          if (json.location?.cityDistrict?.name) {
            const d = String(json.location.cityDistrict.name).trim();
            if (d) ad.district = d;
          }
          // More photos — sometimes the per-offer call surfaces additional
          // images that weren't in the listing response.
          if (Array.isArray(json.images) && json.images.length > ad.images.length) {
            const seen = new Set(ad.images);
            for (const img of json.images) {
              const u = typeof img === 'string' ? img : img?.url;
              if (!u || seen.has(u)) continue;
              seen.add(u);
              ad.images.push(u);
              if (ad.images.length >= 20) break;  // persistListing cap
            }
          }
          // Rooms / area / floor — overwrite from per-offer parameters
          // if they were missing in the listing response.
          if (Array.isArray(json.parameters)) {
            const params = json.parameters;
            const findRe = (re) => params.find(p => re.test(String(p?.name || '')));
            if (ad.rooms == null) {
              const r = findRe(/liczba pokoi|pokoje/i);
              const v = r && (r.values?.[0] ?? r.valuesLabel?.[0]);
              if (v != null) {
                const n = parseNum(v);
                if (n != null) ad.rooms = Math.round(n);
              }
            }
            if (ad.area == null) {
              const a = findRe(/powierzchnia/i);
              const v = a && (a.values?.[0] ?? a.valuesLabel?.[0]);
              if (v != null) {
                const n = parseNum(v);
                if (n != null) ad.area = n;
              }
            }
            if (ad.floor == null) {
              const f = params.find(p => /^\s*pi[eę]tro\s*$/i.test(String(p?.name || '')));
              const v = f && (f.values?.[0] ?? f.valuesLabel?.[0]);
              if (v != null) ad.floor = self._normalizeFloor(v);
            }
          }
          okCount++;
        } catch (e) {
          failCount++;
          if (failCount <= 3 || failCount % 20 === 0) {
            console.warn(
              `[allegro] enrich failed for ${ad.externalId}: ${e.message}`,
              `(${failCount} failures so far)`
            );
          }
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    console.log(
      `[allegro] enrichment done: ${okCount} ok, ${failCount} failed,`,
      `${ads.length - toEnrich.length} skipped (over ENRICH_LIMIT)`
    );
  }

  // ==========================================================================
  // URL + text helpers (mirror the olx/nieruchomosciOnline pattern).
  // ==========================================================================

  // Strip tracking/marketing query params so the same listing always
  // produces the same stored URL (mirrors the olx pattern). Allegro's
  // canonical offer URL is path-only (no utm_*), but normalizing
  // defensively protects against imported URLs with tracking params.
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
}
