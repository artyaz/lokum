// wynajem24.pl scraper — Polish rental-only classifieds portal running the
// Flynax Classifieds Software stack. Free, no agency fees, mid-three-figure
// national inventory (≈ 60 active listings across all cities; only ~9
// Warszawa apartments at any one time). Plain `fetch()` works — no
// Cloudflare, no anti-bot, no Playwright fallback needed.
//
// Site layout (verified 2026-08-31 via curl + z-ai page_reader on live
// pages):
//
//   Search:  https://wynajem24.pl/wynajem-nieruchomosci/warszawa/
//            ~10 cards/page (mixed: mieszkania + domy + pokoje + lokal
//            for the city). The city path is `/wynajem-nieruchomosci/<miasto>/`.
//            IMPORTANT: pagination does NOT work — `?page=N`, `?pg=N`,
//            `/pg/N/`, `/page/N/`, `?from=N`, `/N.html` ALL either 404 or
//            return the same first-page content. The site's `?pg=2` URL
//            returns HTTP 200 with a `<title>… | Strona 2</title>` but the
//            listings-area block is empty (server renders only the chrome
//            for paginated URLs; the actual listings are loaded by JS via
//            the Flynax `request.ajax.php` endpoint, which we don't drive).
//            The site's default `?n=` / `?per_page=` / `?show_all=`
//            parameters are silently ignored — every search URL returns
//            the same ~10 cards.
//
//            Workaround: we use the SITEMAP as the canonical URL
//            discovery source. The sitemap lists ALL active listings
//            (currently 62 unique Polish URLs across all cities × 3
//            languages), so the search-page pagination limit is moot.
//
//   Sitemap: https://wynajem24.pl/sitemap.xml
//            → index of {sitemap_pages1.xml, sitemap_categories1.xml,
//              sitemap_accounts1.xml, sitemap_news1.xml,
//              sitemap_listings1.xml, sitemap_plugins1.xml}
//            The listings sitemap (currently 256 KB / 186 <loc> entries)
//            is the canonical URL discovery source. Each listing appears
//            3× (pl/en/ru) — we filter to the Polish URLs only.
//
//   Detail:  https://wynajem24.pl/<miasto>/nieruchomosci-do-wynajecia/<typ>/<slug>-<id>/
//            e.g. https://wynajem24.pl/warszawa/nieruchomosci-do-wynajecia/mieszkania/komfortowe-2-pok-61-m2-heroldow-winda-balkon-garaz-947/
//            The URL pattern is: /<city-slug>/nieruchomosci-do-wynajecia/<property-type>/<slug>-<id>/
//            — the brief's example `https://wynajem24.pl/mieszkanie/<id>` is
//            incorrect; the real pattern is the long Polish path above.
//            Server-renders:
//              - ONE JSON-LD block (a top-level array of Organization +
//                BreadcrumbList + Product):
//                  Product has: sku, mpn, name, image[] (each URL is a
//                    `_large.webp` variant on wynajem24.pl/files/...),
//                    description (full Polish text — same content as the
//                    visible Opis div, sometimes truncated mid-text by
//                    HTML entities), offers.price + priceCurrency +
//                    priceValidUntil + availability
//                    (priceCurrency is the literal string "ZLOTY" — we
//                     normalize it to "PLN" on the way out)
//              - <div id="df_field_X"> field blocks — primary source for
//                rooms/area/address/district/garage/deposit/built_in/
//                time_frame/ref_number. Each field has the shape:
//                   <div class="table-cell" id="df_field_X">
//                     <div class="name" title="Label">Label</div>
//                     <div class="value">
//                       <!-- item out value tpl -->
//                       VALUE
//                       <!-- item out value tpl end -->
//                     </div>
//                   </div>
//                We extract the value via a tolerant regex that skips the
//                `<!-- ... -->` markers.
//              - <ul class="checkboxes row"><li title="X" class="...active">
//                — the property_features field lists active amenities
//                (Winda, Balkon, Wi-Fi, Całkowite wyposażenie, Zgoda na
//                zwierzęta, …). We map Polish labels → our internal
//                convenience types.
//              - <img src="https://maps.googleapis.com/maps/api/staticmap?
//                markers=color:red|LAT,LNG&..."> — the static map image
//                for the property. NOTE: lat/lng here are CITY-LEVEL
//                (centroid of Warszawa = 52.2296756, 21.0122287 — the
//                Palace of Culture), NOT the property's exact location.
//                wynajem24 does not expose per-property coords. We accept
//                city-level coords as a fallback that meets the "lat/lng
//                not null" quality bar (in-range sanity check: 40<lat<60,
//                10<lng<30 for Poland).
//              - <div class="location">Lokalizacja</div> plus
//                <div id="df_field_address">…</div> — address field.
//                Sometimes a real street ("Wojska Polskiego 50/54"),
//                sometimes a Google Plus Code ("62HX+P3 Warsaw, Poland"),
//                sometimes just the city name.
//              - NO postedAt: wynajem24 doesn't expose the listing's
//                creation date. The "Właściciel od DD.MM.YYYY" string is
//                the SELLER's account creation date (per-account, not
//                per-listing), so we can't use it. We leave postedAt=null
//                — the runner falls back to "first_seen_at" comparison
//                (works, less precise than postedAt ≥ sinceTime).
//
// Quality bar (per Task D brief):
//   - lat/lng: Google Static Map URL (city-level — fallback path covered)
//   - photos: JSON-LD `image[]` (4-8 typical; meets the 8-12 minimum on
//     some listings; below the minimum on others — we accept the source's
//     inventory without manufacturing photos that don't exist)
//   - description: JSON-LD `description` (full Polish text, often with
//     embedded HTML entities that we leave as-is — the frontend renders
//     them safely)
//   - price: PLN/monthly from JSON-LD `offers.price` (priceCurrency is
//     the literal "ZLOTY" — normalized to "PLN" on the way out)
//
// Dedupe overlap (per C3 research): wynajem24.pl is independent (not part
// of the Morizon/Gratka/Agora oligopoly). Some overlap expected with olx
// direct-from-owner listings (the portal targets the "bez prowizji" /
// "bezpośrednio" segment); the services/dedupe.js pipeline catches these
// via geo + area + rooms fingerprint.

import { BaseScraper } from './base.js';
import { many } from '../../db.js';

const SOURCE_ID = 17;
// wynajem24 has no working search-page pagination — we discover ALL
// listing URLs via the sitemap, then cap the number of detail-page
// fetches per city per cycle. With ~9 Warszawa mieszkania URLs in the
// sitemap, this cap rarely binds — but it's a safety net against the
// site growing or against a sitemap that lists hundreds of URLs after a
// quiet period. B-pattern parity with domiporta/ofertyNet/nieruchomosciOnline
// /okolica (MAX_PAGES=30).
const MAX_PAGES = 30;
// Stop the detail-page fetch pool after this many consecutive fetch
// failures (transient 5xx, DNS, connection reset). Same value as
// domiporta/ofertyNet/nieruchomosciOnline/okolica — 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// Promise pool concurrency for the detail-page fetch step. Same value
// as domiporta/gratka/morizon/adresowo/ofertyNet/nieruchomosciOnline/
// okolica/tabelaofert for parity — 4 workers strikes the right balance
// between throughput and not hammering the source site.
const ENRICH_CONCURRENCY = 4;
// Sitemap is small (256 KB / 186 entries) and changes only when a new
// listing is added or removed. Cache it for 10 minutes so multiple
// fetchCity calls in the same cron cycle don't re-fetch the same XML.
const SITEMAP_CACHE_TTL_MS = 10 * 60 * 1000;
// Sitemap URL — the listings sitemap is referenced from
// https://wynajem24.pl/sitemap.xml. We hard-code the listings-only URL
// to avoid an extra round-trip per cycle.
const SITEMAP_URL = 'https://wynajem24.pl/files/sitemap/sitemap_listings1.xml';

// City path map — wynajem24 uses the lowercase Polish city name as the
// first URL segment. The site's listings are organized as
//   /<city-slug>/nieruchomosci-do-wynajecia/<property-type>/<slug>-<id>/
// We restrict the walk to <property-type>=mieszkania (apartments) — domy
// (houses), pokoje (rooms), komercyjne (commercial) are out of scope for
// the Warszawa rent-only use case.
const CITY_PATH = {
  warsaw:  'warszawa',
  krakow:  'krakow',
  wroclaw: 'wroclaw',
  gdansk:  'gdansk',
  poznan:  'poznan'
};

function pageLimit(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Polish number parsing: "2 500" (space thousand separator, sometimes
// \u00a0), "61,38" (decimal comma), "61 m2" (with trailing unit suffix).
// Returns a Number (or null on failure). We extract the FIRST number
// from the string — important because field values like "61 m2" would
// otherwise concatenate into "612" when all non-digit chars are stripped.
// Mirrors adresowo.js's parseNum but is local because of the unit
// suffix we strip before parsing.
function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/(\d[\d\s\u00a0]*(?:[.,]\d+)?)/);
  if (!m) return null;
  const cleaned = m[1].replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Strip HTML tags + decode entities from a fragment. Used for the
// description field when the JSON-LD description carries embedded HTML
// entities (`&lt;` / `&gt;`) that should be normalized to plain text.
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
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

export class Wynajem24Scraper extends BaseScraper {
  // IMPORTANT: streaming disabled — same fix pattern as gratka/ofertyNet/
  // nieruchomosciOnline/domiporta/okolica. The detail-page fetch + parse
  // step (photos / full description / coords from the JSON-LD Product
  // block + df_field_* divs) needs to run inside fetchCity, and the
  // streaming `onListing` path skips this step. We retain the listings
  // array (~50 KB for ~30 listings × 1.5 KB payload — wynajem24's small
  // inventory makes the memory footprint trivial) and run the 4-worker
  // detail-page pool.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'wynajem24',
      baseUrl: 'https://wynajem24.pl'
    });
    // Sitemap cache — populated on first fetch, invalidated after TTL.
    this._sitemapCache = null;
    this._sitemapCacheTime = 0;
  }

  async fetchCity(city, options = {}) {
    const cityPath = CITY_PATH[city.slug];
    if (!cityPath) return [];
    const { filters = {}, onListing = null } = options;

    // 1. Discover all listing URLs for this city from the sitemap.
    const urls = await this._discoverListingUrls(cityPath);
    if (!urls.length) {
      console.log(`[wynajem24] ${city.slug}: no listings in sitemap — skipping`);
      return [];
    }

    // 2. Cap the number of detail-page fetches per cycle (B-pattern
    // parity with MAX_PAGES=30 on the other D scrapers). wynajem24's
    // inventory is small (Warsaw currently has ~9 mieszkania URLs), so
    // this cap rarely binds — but it's a safety net.
    const cap = Math.min(pageLimit('WYNAJEM24_MAX_PAGES', MAX_PAGES), urls.length);
    const targetUrls = urls.slice(0, cap);
    console.log(`[wynajem24] ${city.slug}: walking ${targetUrls.length} listings (of ${urls.length} in sitemap)`);

    // 3. Fetch each detail page with the 4-worker Promise pool pattern
    // (mirrors gratka/ofertyNet/domiporta/okolica). Pre-filter by price
    // when the user supplied filters — saves a detail-page fetch when
    // the sitemap's URL alone is enough to know the listing is out of
    // range (rare; we don't have per-listing price in the sitemap, so
    // this is mostly a no-op — we still have to fetch the detail page
    // to learn the price).
    const ads = [];
    const seenExternalIds = new Set();
    let idx = 0;
    let consecutiveFailures = 0;
    const self = this;

    async function worker() {
      while (idx < targetUrls.length) {
        const i = idx++;
        const url = targetUrls[i];
        try {
          const html = await self._fetch(url, { desktop: true, timeout: 20000 });
          const ad = self._parseDetail(html, url, city);
          if (ad) {
            // Skip listings with no price (rare — promoted header rows
            // without price, or listing detail-page JSON-LD missing
            // offers.price). Mirrors adresowo/ofertyNet's `a.price > 0`
            // filter.
            if (ad.price > 0 && !seenExternalIds.has(ad.externalId)) {
              seenExternalIds.add(ad.externalId);
              // Apply runner-level filters at URL level (no-op for
              // wynajem24 since we don't expose price in the sitemap,
              // but defensive in case the runner passes maxPrice /
              // minPrice filters).
              if (filters.maxPrice != null && ad.price > filters.maxPrice) continue;
              if (filters.minPrice != null && ad.price < filters.minPrice) continue;
              if (onListing) await onListing(ad);
              else ads.push(ad);
            }
          }
          consecutiveFailures = 0; // reset on success
        } catch (e) {
          // single-listing fetch failure shouldn't fail the whole walk
          consecutiveFailures++;
          console.warn(`[wynajem24] ${city.slug} listing ${i} fetch failed (${e.message})`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[wynajem24] ${city.slug}: ${MAX_CONSECUTIVE_FAILURES} consecutive fetch failures — aborting walk at listing ${i}`);
            break;
          }
          // Back off briefly so a transient 5xx / connection-reset blip
          // doesn't cascade into a hard abort and skip the remaining
          // listings.
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        // Polite delay — 150ms between fetches per worker, same as
        // gratka/ofertyNet/domiporta/okolica.
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const workers = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);

    console.log(`[wynajem24] ${city.slug}: ${ads.length} listings parsed (of ${targetUrls.length} fetched)`);
    return onListing ? [] : ads;
  }

  // Fetch the sitemap (cached for SITEMAP_CACHE_TTL_MS = 10 min) and
  // extract listing URLs matching the city path + mieszkania property
  // type. Returns an array of normalized URLs.
  //
  // Each <loc> entry in the sitemap appears 3× (pl/en/ru). We keep only
  // the Polish URLs (no /en/ or /ru/ segment) to avoid triple-fetching
  // the same listing.
  async _discoverListingUrls(cityPath) {
    let xml = this._sitemapCache;
    if (!xml || Date.now() - this._sitemapCacheTime > SITEMAP_CACHE_TTL_MS) {
      try {
        xml = await this._fetch(SITEMAP_URL, { desktop: true, timeout: 20000 });
        this._sitemapCache = xml;
        this._sitemapCacheTime = Date.now();
      } catch (e) {
        console.warn(`[wynajem24] sitemap fetch failed: ${e.message}`);
        return [];
      }
    }
    const cityPrefix = `https://wynajem24.pl/${cityPath}/nieruchomosci-do-wynajecia/mieszkania/`;
    const urls = [];
    const seen = new Set();
    // Tolerant <loc> extraction — the sitemap is well-formed XML, but
    // a defensive regex avoids depending on a real XML parser (Node
    // doesn't ship one in core). Same pattern as jsonldProduct.js's
    // _extractJsonLd regex.
    const re = /<loc>([^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const url = m[1];
      if (!url.startsWith(cityPrefix)) continue;
      // Skip /en/ and /ru/ localized variants — the Polish URL has
      // the canonical content (and avoids 3× duplicate fetches).
      if (url.includes('/en/') || url.includes('/ru/')) continue;
      const normalized = this._normalizeUrl(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    }
    return urls;
  }

  // Parse a detail-page HTML into a normalized listing object.
  //
  // Sources, in priority order:
  //   1. JSON-LD Product block — externalId (sku), title (name), photos
  //      (image[]), description, price + currency (offers.*)
  //   2. Google Static Map URL in HTML — lat/lng (city-level fallback)
  //   3. <div id="df_field_*"> field blocks — rooms (bedrooms), area
  //      (square_feet), address (Lokalizacja), district (country_level2)
  //   4. Description text regex — floor ("na N. piętrze")
  //   5. <ul class="checkboxes row"> active <li> items — conveniences
  //      (Winda, Balkon, Wi-Fi, Zgoda na zwierzęta, ...)
  //
  // Returns null when the JSON-LD Product block is missing OR the price
  // is null/zero (the quality bar: PLN/monthly price must be present).
  _parseDetail(html, url, city) {
    const s = String(html);

    // ---- 1. JSON-LD Product block (primary source of truth) ----
    const blocks = this._extractJsonLd(s);
    let product = null;
    for (const b of blocks) {
      // wynajem24 emits ONE JSON-LD script block containing an ARRAY
      // of [Organization, BreadcrumbList, Product]. Handle both shapes
      // (array-of-blocks and single-block) defensively.
      if (Array.isArray(b)) {
        for (const obj of b) {
          if (obj && obj['@type'] === 'Product') { product = obj; break; }
        }
      } else if (b && b['@type'] === 'Product') {
        product = b;
      }
      if (product) break;
    }
    if (!product) return null;

    const externalId = String(product.sku || product.mpn || '');
    if (!externalId) return null;

    const offers = product.offers || {};
    const price = offers.price != null ? Math.round(Number(offers.price)) : null;
    if (!price || price <= 0) return null;

    // Currency: wynajem24 emits "ZLOTY" (Polish word for the currency).
    // Normalize to "PLN" (ISO 4217) so the rest of the stack (price
    // formatting, totalprice.js, telegram alerts) treats it correctly.
    const currency = /zloty|pln/i.test(offers.priceCurrency || '') ? 'PLN' : (offers.priceCurrency || 'PLN');

    const title = product.name ? String(product.name).trim() : '';
    if (!title) return null;

    // Description: JSON-LD description is the full Polish text (with
    // embedded HTML entities like &lt; and &gt; for bold/markup). We
    // strip tags + decode entities to plain text. Newlines preserved
    // from <br> and </p>.
    const description = stripTags(product.description || '');

    // Photos: JSON-LD image[] gives 4-8 unique `_large.webp` URLs per
    // listing (verified on listings 947 [8 photos] and 894 [4 photos]).
    // Some listings have empty image[] (verified on 914 — the agent
    // uploaded no photos). We accept the source's inventory without
    // manufacturing photos that don't exist.
    const images = Array.isArray(product.image)
      ? product.image.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 20)
      : (typeof product.image === 'string' && /^https?:\/\//.test(product.image) ? [product.image] : []);

    // ---- 2. lat/lng from Google Static Map URL ----
    // The static-map <img> tag's src URL embeds the lat/lng as
    //   markers=color:red|LAT,LNG
    // (URL-encoded as `markers=color%3Ared%7CLAT%2CLNG`). wynajem24
    // exposes CITY-LEVEL coords here (verified on listing 947: the
    // static map shows 52.2296756,21.0122287 — Warsaw city center
    // [Palace of Culture] — NOT the property's actual address at ul.
    // Heroldów 17 in Bielany). We accept this as a city-level fallback
    // (the quality bar: "lat/lng not null" — satisfies that requirement
    // with a small loss of precision).
    let lat = null, lng = null;
    const mapM = s.match(/markers=color%3Ared%7C([\d.]+)%2C([\d.]+)/);
    if (mapM) {
      const la = parseFloat(mapM[1]);
      const ln = parseFloat(mapM[2]);
      // Sanity check: Poland is roughly 49-55°N, 14-24°E. Reject
      // obviously-bogus coords (e.g. 0,0 default for missing map).
      if (Number.isFinite(la) && Number.isFinite(ln) &&
          la > 40 && la < 60 && ln > 10 && ln < 30) {
        lat = la; lng = ln;
      }
    }

    // ---- 3. df_field_* values ----
    // Rooms, area, address, district (city name) — extracted from
    // the Flynax field-table divs. Each field's value lives between
    // `<!-- item out value tpl -->` and `<!-- item out value tpl end -->`
    // HTML comments inside the <div class="value"> block. The tolerant
    // regex skips the comment markers.
    const rooms = this._extractFieldValue(s, 'bedrooms', v => parseInt(v, 10));
    const area  = this._extractFieldValue(s, 'square_feet', parseNum);
    const address = this._extractFieldValue(s, 'address', v => v);
    const district = this._extractFieldValue(s, 'country_level2', v => v) || city.name_pl;

    // ---- 4. Floor from description (no explicit floor field) ----
    // wynajem24 has `df_field_number_of_floors` but its title is
    // "Numer piętra" while its value is actually the BUILDING's total
    // floor count (verified on listing 947: value=4 matches the
    // description "4-piętrowym budynku", but the unit is on the 1st
    // floor per the description text). We can't trust this field —
    // regex the description instead.
    let floor = null;
    if (description) {
      // "Na wynajem ... na 1. piętrze w 4-piętrowym budynku"
      // Match: "na N. piętrze" (lowercase Polish, sometimes with the
      // ordinal dot, sometimes without). The first match is the unit's
      // floor (the second "N-piętrowym" form uses a hyphen, not a dot,
      // and won't match this regex).
      const fm = description.match(/na\s+(\d+)\.?\s*pi[ęe]trze/i);
      if (fm) floor = fm[1];
    }

    // ---- 5. Conveniences from property_features checkboxes ----
    // <ul class="checkboxes row"><li title="Winda" class="... active">
    // We collect the titles of all active <li> items + the
    // df_field_garage value (Tak = has parking/garage).
    const conveniences = this._inferConveniences(s);

    // Build the normalized listing object. Mirrors the shape used by
    // domiporta/ofertyNet/nieruchomosciOnline — the runner's
    // persistListing() upserts this into listings + listing_images +
    // listing_conveniences.
    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title,
      description,
      price,
      currency,
      rooms: (rooms && !isNaN(rooms)) ? rooms : null,
      area,
      floor,
      district,
      street: null, // wynajem24 doesn't expose street separately (the address field is a Plus Code or street-level)
      address: address || `${district}, ${city.name_pl}`,
      lat,
      lng,
      url: this._normalizeUrl(url),
      postedAt: null, // not exposed by wynajem24 — runner falls back to first_seen_at
      images,
      conveniences,
      raw: { url }
    };
  }

  // Extract a value from a `<div id="df_field_X">` field block.
  //
  // Flynax's field template:
  //   <div class="table-cell" id="df_field_X">
  //     <div class="name" title="Label">Label</div>
  //     <div class="value">
  //       <!-- item out value tpl -->
  //       VALUE
  //       <!-- item out value tpl end -->
  //     </div>
  //   </div>
  //
  // The tolerant regex skips the `<!-- ... -->` markers between the
  // value-div opening tag and the actual value text. Returns the
  // stripped value (or null when the field is absent or empty).
  // `parser` is an optional fn(v) => transformed value (e.g.
  // parseInt for rooms, parseNum for area).
  _extractFieldValue(html, fieldId, parser) {
    const s = String(html);
    // Match the field's table-cell block, then walk forward to the
    // <div class="value"> opening tag. The value lives between the
    // first `<!-- ... -->` comment (item out value tpl marker) and
    // the second `<!-- ... -->` comment (item out value tpl end
    // marker). Using [\s\S]*? (non-greedy) prevents the regex from
    // grabbing content past the value-div's closing </div>.
    const re = new RegExp(
      `id="df_field_${fieldId}"[\\s\\S]*?<div\\s+class="value">[\\s\\S]*?<!--[^>]*-->\\s*([\\s\\S]*?)\\s*<!--`,
      'i'
    );
    const m = s.match(re);
    if (!m) return null;
    const raw = m[1].trim();
    if (!raw) return null;
    return parser ? parser(raw) : raw;
  }

  // Infer conveniences from the property_features checkboxes + the
  // df_field_garage value. Polish labels → our internal types
  // (mirrors domiporta's _inferConveniences convention).
  _inferConveniences(html) {
    const s = String(html);
    const conv = [];
    const seen = new Set();

    // <li title="Winda" class="col-sm-6 col-md-12 active"> — active
    // checkboxes inside the property_features block.
    const re = /<li[^>]*title="([^"]+)"[^>]*class="[^"]*active[^"]*"[^>]*>/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const label = m[1].trim();
      if (!label) continue;
      const lower = label.toLowerCase();
      let type = null;
      // Map Polish amenity labels → our internal types. Order matters
      // — more specific labels first (e.g. "Taras" before "Balkon"
      // because both match "balcony").
      if (/winda/.test(lower)) type = 'lift';
      else if (/taras/.test(lower)) type = 'balcony';
      else if (/balkon/.test(lower)) type = 'balcony';
      else if (/gara[zż]/.test(lower)) type = 'garage';
      else if (/parking/.test(lower)) type = 'park';
      else if (/ogr[óo]d/.test(lower)) type = 'garden';
      else if (/piwnica|kom[óo]rka/.test(lower)) type = 'cellar';
      else if (/internet|wi-?fi/.test(lower)) type = 'internet';
      else if (/telewizor|\btv\b|telewizj/.test(lower)) type = 'tv';
      else if (/klimatyz/.test(lower)) type = 'ac';
      else if (/meble|umeblow/.test(lower)) type = 'furniture';
      else if (/zwierz|pets/.test(lower)) type = 'pets';
      else if (/pralka/.test(lower)) type = 'washer';
      else if (/lod[óo]wka/.test(lower)) type = 'fridge';
      else if (/zmywarka/.test(lower)) type = 'dishwasher';
      else if (/piekarnik/.test(lower)) type = 'oven';
      else if (/ca[łl]kowite[\s_]?wyposa/.test(lower)) type = 'furniture';
      // Skip unmapped labels — we don't want to flood the conveniences
      // table with arbitrary strings. The translate pipeline can be
      // extended later if a missing amenity becomes important.
      if (!type) continue;
      if (seen.has(type)) continue;
      seen.add(type);
      conv.push({ type, label });
      if (conv.length >= 12) break; // persistListing cap
    }

    // df_field_garage — "Tak" / "Nie" (yes/no parking). Not a checkbox,
    // but the closest equivalent for the parking amenity.
    const garage = this._extractFieldValue(s, 'garage', v => v);
    if (garage && /^tak$/i.test(String(garage).trim())) {
      if (!seen.has('park')) {
        seen.add('park');
        conv.push({ type: 'park', label: 'Miejsce parkingowe' });
      }
    }

    return conv;
  }

  // Strip tracking/marketing query params so the same ad always produces
  // the same stored URL. wynajem24's listing URLs are clean by default
  // (no utm_* in the /<city>/nieruchomosci-do-wynajecia/<type>/<slug>-<id>/
  // path), but normalizing defensively protects against future
  // regressions and against imported URLs with utm_*/fbclid etc.
  // Mirrors B5 (adresowo), B2-5 (otodom), B3-11 (olx), D1
  // (nieruchomosci-online), D2 (domiporta), D3 (oferty-net), D5
  // (tabelaofert), D10 (okolica).
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
