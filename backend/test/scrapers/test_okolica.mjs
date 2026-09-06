// Test for okolica.js scraper — verifies marker-merge, search-card
// extraction, detail-page enrichment (description, photos, coords,
// direct marker), and the URL normalize helper against real fetched
// HTML samples.
//
// Run: cd backend && node test/scrapers/test_okolica.mjs
//
// Test fixtures (raw HTML cached in /tmp, fetched via curl):
//   /tmp/okolica-search.html    — search results page 1 (Warsaw, all listings).
//                                 ~40 cards with full data (price, rooms,
//                                 area, floor, district, photos, relative
//                                 postedAt).
//   /tmp/okolica-markers.json   — markers/search JSON response for Warsaw
//                                 (1 742 entries: [lat, lng, external_id,
//                                 "W/1", 2]). Used to test the markers-merge
//                                 path.
//   /tmp/okolica-detail.html    — sample detail page (Solec 79 kawalerka,
//                                 2 300 PLN, 1 room, 36 m², 7th floor,
//                                 direct-from-owner, 9 photos, 2700-char
//                                 description with <br> tags).
//
// The scraper's `_fetch` (inherited from BaseScraper) is NOT used — instead
// the test injects the cached HTML directly by patching the instance, so
// the test runs offline and is hermetic.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OkolicaScraper } from '../../src/services/scrapers/okolica.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = '/tmp';

function readText(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const SEARCH_HTML  = readText(path.join(TMP, 'okolica-search.html'));
const MARKERS_JSON = readText(path.join(TMP, 'okolica-markers.json'));
const DETAIL_HTML  = readText(path.join(TMP, 'okolica-detail.html'));

const CITY = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.23, lng: 21.01 };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name} ${extra}`); fail++; }
}

console.log('--- Test: okolica.js scraper ---');

const scraper = new OkolicaScraper();
const fetched = [];
scraper._fetch = async (url, opts) => {
  fetched.push(url);
  // Markers/search endpoint — return the cached JSON.
  if (/\/markers\/search\/?/.test(url) && MARKERS_JSON) return MARKERS_JSON;
  // Search page 1 — return the cached Warsaw search HTML.
  if (/\/mieszkanie\/wynajme\/warszawa\/?(\?|$)/.test(url) && !/page=2/.test(url) && SEARCH_HTML) return SEARCH_HTML;
  // Detail page — return the cached detail HTML.
  if (/\/offer\/show\/34912-W-39468_4034_OMW\/formular/.test(url) && DETAIL_HTML) return DETAIL_HTML;
  throw new Error(`test has no fixture for ${url}`);
};

// ----- TEST 1: source registration sanity -----
console.log('\n[T1] Source registration sanity');
check('scraper sourceId=15', scraper.sourceId === 15);
check('scraper sourceSlug=okolica', scraper.sourceSlug === 'okolica');
check('scraper baseUrl=https://www.okolica.pl', scraper.baseUrl === 'https://www.okolica.pl');
check('scraper supportsStreaming=false', scraper.supportsStreaming === false);

// ----- TEST 2: markers/search API fetch -----
console.log('\n[T2] markers/search API fetch + parsing');
if (MARKERS_JSON) {
  const markers = await scraper._fetchMarkers(CITY, 'Warszawa, Mazowieckie');
  check('markers returned a Map', markers instanceof Map);
  check('markers Map has 1000+ entries (Warsaw has 1 742)', markers.size >= 1000, `(size=${markers.size})`);
  // Find the Solec listing in markers
  const sole = markers.get('34912-W-39468_4034_OMW');
  check('markers has Solec 34912-W-39468_4034_OMW', !!sole, `(got ${sole ? sole.lat + ',' + sole.lng : 'null'})`);
  if (sole) {
    check('Solec lat plausible Warsaw (52.x)', sole.lat > 52.0 && sole.lat < 52.5, `(lat=${sole.lat})`);
    check('Solec lng plausible Warsaw (20-21.x)', sole.lng > 20.5 && sole.lng < 21.5, `(lng=${sole.lng})`);
    console.log(`    Solec marker: lat=${sole.lat} lng=${sole.lng}`);
  }
} else {
  console.log('    (skipped - no /tmp/okolica-markers.json fixture)');
}

// ----- TEST 3: search-page card extraction (real HTML) -----
console.log('\n[T3] Search page card extraction');
if (SEARCH_HTML) {
  const cards = scraper._parseSearchCards(SEARCH_HTML, CITY);
  check('search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('search returns at least 20 cards', cards.length >= 20, `(got ${cards.length})`);
  check('search returns up to 40 cards (OFFERS_PER_PAGE)', cards.length <= 40, `(got ${cards.length})`);
  const c0 = cards.find(c => c.externalId === '34912-W-39468_4034_OMW') || cards[0] || {};
  check('card has externalId', !!c0.externalId, `(id=${c0.externalId})`);
  check('card has url starting https://www.okolica.pl', !!c0.url && c0.url.startsWith('https://www.okolica.pl'), `(url=${c0.url})`);
  check('card url contains /offer/show/', /\/offer\/show\//.test(c0.url || ''));
  check('card url ends with /formular', /\/formular$/.test(c0.url || ''));
  check('card has price', c0.price != null && c0.price > 0, `(price=${c0.price})`);
  check('card price is 2300 PLN (Solec)', c0.price === 2300, `(price=${c0.price})`);
  check('card has rooms', c0.rooms != null, `(rooms=${c0.rooms})`);
  check('card rooms is 1', c0.rooms === 1, `(rooms=${c0.rooms})`);
  check('card has area', c0.area != null && c0.area > 0, `(area=${c0.area})`);
  check('card area is 36', c0.area === 36, `(area=${c0.area})`);
  check('card has floor', c0.floor != null, `(floor=${c0.floor})`);
  check('card floor is "7"', c0.floor === '7', `(floor=${c0.floor})`);
  check('card has currency=PLN', c0.currency === 'PLN');
  check('card has sourceId=15', c0.sourceId === 15);
  check('card has title', !!c0.title);
  console.log(`    Solec card: id=${c0.externalId} price=${c0.price}PLN rooms=${c0.rooms} area=${c0.area}m2 floor=${c0.floor}`);
  console.log(`    Solec url: ${c0.url}`);
  console.log(`    Solec title: ${c0.title}`);
  console.log(`    Solec district: ${c0.district}`);
  console.log(`    Solec photos: ${c0.images?.length || 0} (from search card list2x)`);
  check('card has photos', Array.isArray(c0.images) && c0.images.length > 0, `(count=${c0.images?.length})`);
  check('card has 5+ photos (target 8-12)', c0.images?.length >= 5, `(count=${c0.images?.length})`);
  check('photo urls start https://', c0.images?.every(u => u.startsWith('https://')));
  check('photo urls on okolica.pl/media/cache', c0.images?.every(u => u.includes('okolica.pl/media/cache/')));
} else {
  console.log('    (skipped - no /tmp/okolica-search.html fixture)');
}

// ----- TEST 4: detail-page description + photos + coords + direct marker -----
console.log('\n[T4] Detail-page enrichment (Solec 79 kawalerka)');
if (DETAIL_HTML) {
  const ad = {
    externalId: '34912-W-39468_4034_OMW',
    price: 2300, currency: 'PLN',
    images: [], raw: {}, description: '', postedAt: null,
    conveniences: [], lat: null, lng: null,
    title: 'fallback', rooms: 1, area: 36, floor: '7'
  };
  scraper._applyDetail(DETAIL_HTML, ad);
  check('description returned', !!ad.description, `(len=${ad.description?.length})`);
  check('description length >= 500', ad.description && ad.description.length >= 500, `(len=${ad.description?.length})`);
  check('description length >= 1500 (target)', ad.description && ad.description.length >= 1500, `(len=${ad.description?.length})`);
  check('description is Polish (contains mieszkanie/zł/wynaj)', /mieszkanie|zł|wynaj/i.test(ad.description || ''));
  check('description has newlines from <br>', (ad.description || '').includes('\n'));
  check('description mentions "Powiśle" (Solec sub-district)', /Powi[sś]le/i.test(ad.description || ''));
  console.log(`    description length: ${ad.description?.length} chars`);
  console.log(`    first 200: ${(ad.description || '').slice(0, 200)}`);

  check('photos returned', Array.isArray(ad.images) && ad.images.length > 0, `(got ${ad.images?.length})`);
  check('photos count >= 5', ad.images.length >= 5, `(got ${ad.images.length})`);
  check('photos count >= 8 (target)', ad.images.length >= 8, `(got ${ad.images.length})`);
  check('photo url starts https://', ad.images.every(u => u.startsWith('https://')));
  check('photo url on okolica.pl/media/cache', ad.images.every(u => u.includes('okolica.pl/media/cache/')));
  check('photo url uses cart2x or cart_zoom variant (highest ranked)', ad.images.every(u => /\/media\/cache\/(cart2x|cart_zoom)\//.test(u)));
  console.log(`    extracted ${ad.images.length} photos:`);
  ad.images.slice(0, 3).forEach(u => console.log(`      - ${u}`));
  if (ad.images.length > 3) console.log(`      ... +${ad.images.length - 3} more`);

  check('coords returned from <div id="map" data-lat data-lng>', ad.lat != null && ad.lng != null, `(lat=${ad.lat},lng=${ad.lng})`);
  if (ad.lat != null) {
    check('lat plausible Warsaw (52.x)', ad.lat > 52.0 && ad.lat < 52.5, `(lat=${ad.lat})`);
    check('lng plausible Warsaw (20-21.x)', ad.lng > 20.5 && ad.lng < 21.5, `(lng=${ad.lng})`);
    console.log(`    coords: lat=${ad.lat} lng=${ad.lng}`);
  }

  check('postedAt returned', !!ad.postedAt, `(postedAt=${ad.postedAt})`);
  if (ad.postedAt) {
    check('postedAt is ISO format', /^\d{4}-\d{2}-\d{2}T/.test(ad.postedAt), `(postedAt=${ad.postedAt})`);
    check('postedAt is 2026-08-29', ad.postedAt.startsWith('2026-08-29'), `(postedAt=${ad.postedAt})`);
  }

  check('conveniences array present', Array.isArray(ad.conveniences));
  check('direct marker convenience extracted', ad.conveniences?.some(c => c.type === 'direct'), `(convs=${JSON.stringify(ad.conveniences)})`);

  check('title upgraded from JSON-LD name (not "fallback")', ad.title !== 'fallback', `(title=${ad.title})`);
  check('title contains "Kawalerka" or "Solec"', /Kawalerka|Solec/i.test(ad.title || ''), `(title=${ad.title})`);

  check('price verified (2300 PLN from JSON-LD offers.price)', ad.price === 2300, `(price=${ad.price})`);
  check('rooms verified (1)', ad.rooms === 1, `(rooms=${ad.rooms})`);
  check('area verified (36)', ad.area === 36, `(area=${ad.area})`);
  check('floor verified ("7")', ad.floor === '7', `(floor=${ad.floor})`);
} else {
  console.log('    (skipped - no /tmp/okolica-detail.html fixture)');
}

// ----- TEST 5: _normalizeUrl -----
console.log('\n[T5] _normalizeUrl');
const u1 = scraper._normalizeUrl('https://www.okolica.pl/offer/show/34912-W-39468_4034_OMW/formular?utm_source=fb&fbclid=abc123');
check('strips utm_ and fbclid params', /utm_|fbclid/.test(u1) === false, `(url=${u1})`);
check('preserves path + listing id', /\/offer\/show\/34912-W-39468_4034_OMW\/formular$/.test(u1), `(url=${u1})`);
const u2 = scraper._normalizeUrl('https://www.okolica.pl/offer/show/34912-W-39468_4034_OMW/formular');
check('clean url unchanged', u2 === 'https://www.okolica.pl/offer/show/34912-W-39468_4034_OMW/formular', `(url=${u2})`);
const u3 = scraper._normalizeUrl(null);
check('null url returns null', u3 === null);
// The page=N query is NOT a tracking param — keep it.
const u4 = scraper._normalizeUrl('https://www.okolica.pl/mieszkanie/wynajme/warszawa/?page=2');
check('preserves page param (non-tracking)', /page=2/.test(u4), `(url=${u4})`);

// ----- TEST 6: parseRelativePostedAt -----
console.log('\n[T6] parseRelativePostedAt helper');
// Expose via the scraper's prototype indirectly — test the regex behavior.
// "23 min temu" should give ~now - 23 minutes.
const now = Date.now();
const ts1 = (await import('node:assert')).ok; // placeholder to use await

// We can't import the helper directly (it's module-private); test indirectly
// via the search-card parse — the Solec card has "23 min temu" so should
// have a non-null postedAt (until _applyDetail overwrites it with datePosted).
if (SEARCH_HTML) {
  const cards = scraper._parseSearchCards(SEARCH_HTML, CITY);
  const sole = cards.find(c => c.externalId === '34912-W-39468_4034_OMW');
  if (sole) {
    check('search card postedAt parsed (relative time)', !!sole.postedAt, `(postedAt=${sole.postedAt})`);
  } else {
    // Fallback — any card with a relative timestamp.
    const withTs = cards.find(c => c.postedAt);
    check('at least one card has parsed postedAt', !!withTs, `(cards with postedAt: ${cards.filter(c => c.postedAt).length})`);
  }
}

// ----- TEST 7: fetchCity end-to-end (mocked) -----
console.log('\n[T7] fetchCity end-to-end (mocked)');
(async () => {
  // Reset the fetch mock to track detail-page fetches during enrichment.
  const fetchLog = [];
  scraper._fetch = async (url, opts) => {
    fetchLog.push(url);
    if (/\/markers\/search\/?/.test(url) && MARKERS_JSON) return MARKERS_JSON;
    if (/\/mieszkanie\/wynajme\/warszawa\/?(\?|$)/.test(url) && !/page=2/.test(url) && SEARCH_HTML) return SEARCH_HTML;
    if (/\/offer\/show\/34912-W-39468_4034_OMW\/formular/.test(url) && DETAIL_HTML) return DETAIL_HTML;
    // For other listings (page 1 has 40 cards but we only have 1 detail
    // fixture), throw — the enrich pool's try/catch handles it.
    if (/\/offer\/show\//.test(url)) throw new Error(`test fetchCity mock has no detail fixture for ${url}`);
    throw new Error(`test fetchCity mock has no fixture for ${url}`);
  };
  // Use OKOLICA_MAX_PAGES=1 so we only walk page 1 (we have only 1 detail
  // fixture; don't want to mock 44 pages of cards).
  process.env.OKOLICA_MAX_PAGES = '1';
  // Stub the DB many() call inside _enrichNew so it returns [] — without a
  // real DB connection, the enrich pool would skip every listing. We want
  // the Solec listing (which has 0 photos initially) to be enriched.
  // The scraper imports { many } from '../../db.js' at module top, so we
  // can't easily stub it without a real DB. Workaround: patch the scraper
  // instance's behavior by setting ENRICH_LIMIT high and trusting the
  // try/catch to skip the DB call. The knownWithImages Set stays empty →
  // all listings are eligible for enrich.
  try {
    const ads = await scraper.fetchCity(CITY, { filters: {}, sinceTime: null });
    delete process.env.OKOLICA_MAX_PAGES;
    check('fetchCity returned >0 ads', ads.length > 0, `(got ${ads.length})`);
    check('fetchCity returned cards with price', ads.every(a => a.price > 0));
    check('fetchCity returned cards with url', ads.every(a => a.url && a.url.startsWith('https://www.okolica.pl')));
    check('fetchCity returned cards with sourceId=15', ads.every(a => a.sourceId === 15));
    check('fetchCity returned cards with currency=PLN', ads.every(a => a.currency === 'PLN'));
    check('fetchCity returned cards with cityId=1', ads.every(a => a.cityId === 1));
    // At least one card should have coords (merged from markers/search).
    const withCoords = ads.filter(a => a.lat != null && a.lng != null);
    check('at least one card has coords (markers merged)', withCoords.length > 0, `(count=${withCoords.length})`);
    check('most cards have coords', withCoords.length >= ads.length * 0.8, `(count=${withCoords.length}/${ads.length})`);
    // Detail-page enrichment should have fetched the Solec detail URL.
    const detailFetches = fetchLog.filter(u => /\/offer\/show\//.test(u));
    check('detail-page enrichment ran (>=1 fetch)', detailFetches.length >= 1, `(count=${detailFetches.length})`);
    // Markers/search should have been called exactly once.
    const markerFetches = fetchLog.filter(u => /\/markers\/search\/?/.test(u));
    check('markers/search called exactly once', markerFetches.length === 1, `(count=${markerFetches.length})`);
    // Find the Solec listing — its detail HTML was fetched, so it should
    // have full description, cart2x photos, postedAt, direct marker.
    const z = ads.find(a => a.externalId === '34912-W-39468_4034_OMW');
    check('Solec ad enriched', !!z);
    if (z) {
      check('Solec ad has price=2300', z.price === 2300, `(price=${z.price})`);
      check('Solec ad has area=36', z.area === 36, `(area=${z.area})`);
      check('Solec ad has rooms=1', z.rooms === 1, `(rooms=${z.rooms})`);
      check('Solec ad has floor="7"', z.floor === '7', `(floor=${z.floor})`);
      check('Solec ad has lat (markers merged or detail fallback)', z.lat != null, `(lat=${z.lat})`);
      check('Solec ad has lng', z.lng != null, `(lng=${z.lng})`);
      check('Solec ad has description (>=1500 chars)', z.description && z.description.length > 1500, `(len=${z.description?.length})`);
      check('Solec ad has images (>=8)', z.images && z.images.length >= 8, `(count=${z.images?.length})`);
      check('Solec ad has conveniences (>=1)', z.conveniences && z.conveniences.length >= 1, `(count=${z.conveniences?.length})`);
      check('Solec ad has direct marker convenience', z.conveniences?.some(c => c.type === 'direct'));
      check('Solec ad has postedAt from detail JSON-LD (2026-08-29)', z.postedAt && z.postedAt.startsWith('2026-08-29'), `(postedAt=${z.postedAt})`);
      console.log(`    Solec ad: price=${z.price}PLN rooms=${z.rooms} area=${z.area}m² floor=${z.floor} lat=${z.lat} lng=${z.lng}`);
      console.log(`    Solec images: ${z.images?.length} photos (cart2x)`);
      console.log(`    Solec desc len: ${z.description?.length} chars`);
      console.log(`    Solec conveniences: ${JSON.stringify(z.conveniences)}`);
      console.log(`    Solec postedAt: ${z.postedAt}`);
    }
  } catch (e) {
    delete process.env.OKOLICA_MAX_PAGES;
    console.error('    fetchCity end-to-end failed:', e.message);
    fail++;
  }
})();

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
if (fail > 0) process.exit(1);
