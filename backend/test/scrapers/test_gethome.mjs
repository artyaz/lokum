// Test for gethome.js scraper — verifies photo, description, coords, and
// search-card extraction against real fetched HTML samples.
//
// Run: cd backend && node test/scrapers/test_gethome.mjs
//
// Test fixtures (raw HTML cached in /tmp, fetched via z-ai page_reader on
// live pages — gethome.pl is behind Cloudflare, so plain curl returns 403;
// page_reader uses a real headless browser that passes the CF challenge):
//   /tmp/gethome-search.html       — search results "bez-posrednikow" page 1
//                                    (Warsaw direct-from-owner, 26 offers).
//   /tmp/gethome-search-all.html   — search results unfiltered page 1
//                                    (Warsaw all wynajem, 35 offers out of 863
//                                    total across 25 pages).
//   /tmp/gethome-detail.html       — sample detail page (Wąwolnicka 64.88m²,
//                                    3 rooms, 2. piętro, kamienica 1952, full
//                                    1990-char Polish description).
//
// The scraper's `_fetchBypassingChallenge` is NOT used — instead the test
// injects the cached HTML directly by patching the instance's `_fetch`
// (which `_fetchBypassingChallenge` calls first; the challenge markers are
// absent from the fixture, so the fallback to fetchRendered is skipped).

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GethomeScraper } from '../../src/services/scrapers/gethome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = '/tmp';

function readHtml(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const SEARCH_BEZPOS_HTML  = readHtml(path.join(TMP, 'gethome-search.html'));
const SEARCH_ALL_HTML     = readHtml(path.join(TMP, 'gethome-search-all.html'));
const DETAIL_HTML         = readHtml(path.join(TMP, 'gethome-detail.html'));

const CITY = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.23, lng: 21.01 };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name} ${extra}`); fail++; }
}

console.log('--- Test: gethome.js scraper ---');

const scraper = new GethomeScraper();
const fetched = [];
// Patch _fetch so _fetchBypassingChallenge sees the cached HTML (the
// Cloudflare markers are absent from the fixture, so the fetchRendered
// fallback path is never triggered — the cached HTML is returned as-is).
scraper._fetch = async (url, opts) => {
  fetched.push(url);
  if (/\/mieszkania\/do-wynajecia\/warszawa\/t\/bez-posrednikow/.test(url) && SEARCH_BEZPOS_HTML) return SEARCH_BEZPOS_HTML;
  if (/\/mieszkania\/do-wynajecia\/warszawa\/?(\?|$)/.test(url) && SEARCH_ALL_HTML) return SEARCH_ALL_HTML;
  if (/\/oferta\/wynajme-mieszkanie-warszawa-wawolnicka/.test(url) && DETAIL_HTML) return DETAIL_HTML;
  throw new Error(`test has no fixture for ${url}`);
};

// ----- TEST 1: search-page card extraction (direct-from-owner feed) -----
console.log('\n[T1] Search page card extraction (bez-posrednikow feed)');
if (SEARCH_BEZPOS_HTML) {
  const cards = scraper._parseSearchCards(SEARCH_BEZPOS_HTML, CITY);
  check('search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('search returns >=20 cards', cards.length >= 20, `(got ${cards.length})`);
  check('search returns 26 cards (bez-posrednikow Warszawa total)', cards.length === 26, `(got ${cards.length})`);

  const c0 = cards[0] || {};
  check('card has externalId (UUID)', !!c0.externalId, `(id=${c0.externalId})`);
  check('card externalId is UUID shape', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c0.externalId || ''), `(id=${c0.externalId})`);
  check('card has url starting https://gethome.pl', !!c0.url && c0.url.startsWith('https://gethome.pl'), `(url=${c0.url})`);
  check('card url contains /oferta/', /\/oferta\//.test(c0.url || ''));
  check('card url has trailing slash', /\/$/.test(c0.url || ''));
  check('card has price', c0.price != null && c0.price > 0, `(price=${c0.price})`);
  check('card price is 2650 PLN', c0.price === 2650, `(price=${c0.price})`);
  check('card has rooms', c0.rooms != null, `(rooms=${c0.rooms})`);
  check('card rooms is 1', c0.rooms === 1, `(rooms=${c0.rooms})`);
  check('card has area', c0.area != null && c0.area > 0, `(area=${c0.area})`);
  check('card area is 41.4', c0.area === 41.4, `(area=${c0.area})`);
  check('card has floor', c0.floor != null, `(floor=${c0.floor})`);
  check('card floor is "5"', c0.floor === '5', `(floor=${c0.floor})`);
  check('card has district', !!c0.district, `(district=${c0.district})`);
  check('card district is "Bielany"', c0.district === 'Bielany', `(district=${c0.district})`);
  check('card has street=Sandora Petofiego', c0.street === 'Sandora Petofiego', `(street=${c0.street})`);
  check('card has lat', c0.lat != null, `(lat=${c0.lat})`);
  check('card has lng', c0.lng != null, `(lng=${c0.lng})`);
  check('card lat plausible Warsaw (52.x)', c0.lat > 52.0 && c0.lat < 52.5, `(lat=${c0.lat})`);
  check('card lng plausible Warsaw (20-21.x)', c0.lng > 20.5 && c0.lng < 21.5, `(lng=${c0.lng})`);
  check('card has currency=PLN', c0.currency === 'PLN');
  check('card has sourceId=11', c0.sourceId === 11);
  check('card has title', !!c0.title);
  check('card has postedAt (ISO date)', !!c0.postedAt, `(postedAt=${c0.postedAt})`);
  check('card postedAt is 2026-08-29', c0.postedAt?.startsWith('2026-08-29'), `(postedAt=${c0.postedAt})`);
  check('card has images', Array.isArray(c0.images) && c0.images.length > 0, `(got ${c0.images?.length})`);
  check('card has >=8 images (quality bar minimum)', c0.images?.length >= 8, `(got ${c0.images?.length})`);
  check('card images on thumbs.gethome.pl CDN', c0.images?.every(u => u.includes('thumbs.gethome.pl')), `(sample=${c0.images?.[0]})`);
  check('card images use o_img_500 variant (500px wide)', c0.images?.every(u => /\/500x0\//.test(u)), `(sample=${c0.images?.[0]})`);
  check('card has direct marker convenience (is_private=true)', c0.conveniences?.some(c => c.type === 'direct'));
  console.log(`    first card: id=${c0.externalId} price=${c0.price}PLN rooms=${c0.rooms} area=${c0.area}m² floor=${c0.floor}`);
  console.log(`    first card url: ${c0.url}`);
  console.log(`    first card district/street: ${c0.district} / ${c0.street}`);
  console.log(`    first card lat/lng: ${c0.lat} / ${c0.lng}`);
  console.log(`    first card images: ${c0.images?.length} photos`);
  console.log(`    first card postedAt: ${c0.postedAt}`);
} else {
  console.log('    (skipped - no /tmp/gethome-search.html fixture)');
}

// ----- TEST 2: search-page card extraction (unfiltered feed) -----
console.log('\n[T2] Search page card extraction (unfiltered feed)');
if (SEARCH_ALL_HTML) {
  const cards = scraper._parseSearchCards(SEARCH_ALL_HTML, CITY);
  check('all-search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('all-search returns 35 cards (OFFERS_PER_PAGE)', cards.length === 35, `(got ${cards.length})`);

  // Photo count distribution — the unfiltered feed has 6-20 photos per
  // listing (avg 13 — well above the 8-12 quality bar minimum).
  const photoCounts = cards.map(c => c.images.length).sort((a, b) => a - b);
  const min = photoCounts[0];
  const max = photoCounts[photoCounts.length - 1];
  const avg = (photoCounts.reduce((s, n) => s + n, 0) / photoCounts.length).toFixed(2);
  check('min photos >=5', min >= 5, `(min=${min})`);
  check('max photos >=15', max >= 15, `(max=${max})`);
  check('avg photos >=10 (quality bar)', parseFloat(avg) >= 10, `(avg=${avg})`);
  console.log(`    photo distribution: min=${min} max=${max} avg=${avg}`);

  // Coords — every card should have non-null lat/lng (the rental feed
  // requires coords). Quality bar: location not null.
  const withCoords = cards.filter(c => c.lat != null && c.lng != null);
  check('all cards have lat/lng (quality bar)', withCoords.length === cards.length, `(with coords=${withCoords.length}/${cards.length})`);

  // All cards have price > 0 (price quality bar).
  const withPrice = cards.filter(c => c.price != null && c.price > 0);
  check('all cards have price > 0 (quality bar)', withPrice.length === cards.length, `(with price=${withPrice.length}/${cards.length})`);

  // All cards have currency=PLN.
  check('all cards have currency=PLN', cards.every(c => c.currency === 'PLN'));

  // All cards have a UUID externalId.
  check('all cards have UUID externalId', cards.every(c => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.externalId || '')));

  // All card URLs match the /oferta/<slug>/ pattern.
  check('all card urls match /oferta/<slug>/', cards.every(c => /\/oferta\/[a-z0-9-]+\/$/.test(c.url || '')));

  // Find the Wąwolnicka listing for the detail-enrichment test.
  const w = cards.find(c => c.url.includes('wawolnicka'));
  check('Wąwolnicka card found in unfiltered feed', !!w);
  if (w) {
    check('Wąwolnicka price=4100', w.price === 4100, `(price=${w.price})`);
    check('Wąwolnicka rooms=3', w.rooms === 3, `(rooms=${w.rooms})`);
    check('Wąwolnicka area=64.88', w.area === 64.88, `(area=${w.area})`);
    check('Wąwolnicka floor="2"', w.floor === '2', `(floor=${w.floor})`);
    check('Wąwolnicka has description (250 chars, truncated)', w.description.length > 0 && w.description.length <= 260, `(len=${w.description.length})`);
    console.log(`    Wąwolnicka card: id=${w.externalId} price=${w.price}PLN rooms=${w.rooms} area=${w.area}m² floor=${w.floor}`);
    console.log(`    Wąwolnicka search desc (truncated): ${w.description.slice(0, 100)}…`);
  }
} else {
  console.log('    (skipped - no /tmp/gethome-search-all.html fixture)');
}

// ----- TEST 3: detail-page description + property enrichment -----
console.log('\n[T3] Detail-page description + property enrichment');
if (DETAIL_HTML) {
  const ad = {
    externalId: 'e2d25443-e907-482f-a17a-d2fc37ad6014',
    price: 4100, currency: 'PLN',
    rooms: 3, area: 64.88, floor: '2',
    district: 'Praga-Południe', street: 'Wąwolnicka',
    lat: 52.24018, lng: 21.0774,
    url: 'https://gethome.pl/oferta/wynajme-mieszkanie-warszawa-wawolnicka-65m2-trzypokojowe-2-pietro-z-1952-roku-2369134/',
    postedAt: '2026-08-28T13:37:08Z',
    images: ['https://thumbs.gethome.pl/sample/500x0/photo.jpg'],
    conveniences: [],
    raw: { slug: 'wynajme-mieszkanie-warszawa-wawolnicka-...-2369134' },
    description: 'Short 250-char search-blob description used as fallback…',
    title: 'Mieszkanie Wąwolnicka WARSZAWA'
  };
  scraper._applyDetail(DETAIL_HTML, ad);
  check('description returned', !!ad.description, `(len=${ad.description?.length})`);
  check('description length > search blob (250)', ad.description && ad.description.length > 250, `(len=${ad.description?.length})`);
  check('description length >= 500 (full text)', ad.description && ad.description.length >= 500, `(len=${ad.description?.length})`);
  check('description length >= 1500 (target)', ad.description && ad.description.length >= 1500, `(len=${ad.description?.length})`);
  check('description is Polish (contains mieszkanie/zł/wynaj)', /mieszkanie|zł|wynaj|m/i.test(ad.description || ''));
  check('description has newlines (paragraph breaks)', (ad.description || '').includes('\n'));
  check('description contains "Na wynajem" or "Do wynajęcia"', /Na wynajem|Do wynajęcia|do wynajęcia/i.test(ad.description || ''));
  console.log(`    description length: ${ad.description?.length} chars (was 245 on search)`);
  console.log(`    first 200: ${(ad.description || '').slice(0, 200)}`);

  // Property precision overrides.
  check('floor preserved as "2"', ad.floor === '2', `(floor=${ad.floor})`);
  check('rooms preserved as 3', ad.rooms === 3, `(rooms=${ad.rooms})`);
  check('area preserved as 64.88', ad.area === 64.88, `(area=${ad.area})`);
  // Detail blob has more precise coords (property.coordinates.lng/lat) — verify
  // the override worked (precision went from 52.24018 → 52.2401774).
  check('lat refined to detail-blob precision', ad.lat === 52.2401774, `(lat=${ad.lat})`);
  check('lng refined to detail-blob precision', ad.lng === 21.0773838, `(lng=${ad.lng})`);
  console.log(`    lat: ${ad.lat} lng: ${ad.lng} (detail-blob precision)`);

  // raw.params should have been populated from the detail's property fields.
  check('raw.params populated', Array.isArray(ad.raw?.params) && ad.raw.params.length > 0, `(count=${ad.raw?.params?.length})`);
  if (ad.raw?.params?.length) {
    check('raw.params has Ogrzewanie', ad.raw.params.some(p => p.name === 'Ogrzewanie'));
    check('raw.params has Typ budynku', ad.raw.params.some(p => p.name === 'Typ budynku'));
    check('raw.params has Stan wykończenia', ad.raw.params.some(p => p.name === 'Stan wykończenia'));
    check('raw.params has Piętro', ad.raw.params.some(p => p.name === 'Piętro'));
    check('raw.params has Liczba pięter w budynku', ad.raw.params.some(p => p.name === 'Liczba pięter w budynku'));
    console.log(`    raw.params count: ${ad.raw.params.length}`);
    ad.raw.params.slice(0, 4).forEach(p => console.log(`      - ${p.name}: ${p.value}`));
  }

  // IMPORTANT: detail blob does NOT include a pictures[] array — the search
  // blob's pictures[] IS the canonical photo source. Verify we didn't
  // overwrite/lose the search-time images.
  check('images preserved from search (NOT overwritten by detail)', ad.images?.length === 1, `(got ${ad.images?.length})`);
  check('image url unchanged', ad.images?.[0] === 'https://thumbs.gethome.pl/sample/500x0/photo.jpg', `(url=${ad.images?.[0]})`);
} else {
  console.log('    (skipped - no /tmp/gethome-detail.html fixture)');
}

// ----- TEST 4: _normalizeUrl -----
console.log('\n[T4] _normalizeUrl');
const u1 = scraper._normalizeUrl('https://gethome.pl/oferta/wynajme-mieszkanie-x-2369134/?utm_source=fb&fbclid=abc123');
check('strips utm_ and fbclid params', /utm_|fbclid/.test(u1) === false, `(url=${u1})`);
check('preserves path + trailing slash', /\/oferta\/wynajme-mieszkanie-x-2369134\/$/.test(u1), `(url=${u1})`);
const u2 = scraper._normalizeUrl('https://gethome.pl/oferta/wynajme-mieszkanie-x-2369134/');
check('clean url unchanged', u2 === 'https://gethome.pl/oferta/wynajme-mieszkanie-x-2369134/', `(url=${u2})`);
const u3 = scraper._normalizeUrl(null);
check('null url returns null', u3 === null);
// The page=N param is NOT a tracking param — keep it.
const u4 = scraper._normalizeUrl('https://gethome.pl/mieszkania/do-wynajecia/warszawa/?page=2&utm_source=x');
check('preserves page param (non-tracking)', /page=2/.test(u4), `(url=${u4})`);
check('strips utm_source param', !/utm_source/.test(u4), `(url=${u4})`);

// ----- TEST 5: Source registration sanity -----
console.log('\n[T5] Source registration sanity');
check('scraper sourceId=11', scraper.sourceId === 11);
check('scraper sourceSlug=gethome', scraper.sourceSlug === 'gethome');
check('scraper baseUrl=https://gethome.pl', scraper.baseUrl === 'https://gethome.pl');
check('scraper supportsStreaming=false', scraper.supportsStreaming === false);

// ----- TEST 6: Cloudflare challenge detection -----
console.log('\n[T6] Cloudflare challenge detection (mocked)');
(async () => {
  // Patch fetchRendered to track when it's called.
  let renderedCalls = [];
  const origFetchRendered = (await import('../../src/services/browser.js')).fetchRendered;
  // Override via property assignment — _fetchBypassingChallenge reads it
  // from the module import, so we need to re-import after stubbing. Instead
  // we just test that a CF-shell HTML response triggers the Playwright
  // path by intercepting at the scraper instance level. The scraper uses
  // `fetchRendered` from the module scope (not `this.fetchRendered`), so
  // we can't easily stub it per-instance — but we can verify the
  // CHALLENGE_MARKERS list is in scope by checking the file's source.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'scrapers', 'gethome.js'), 'utf8');
  check('source imports fetchRendered from browser.js', /import \{ fetchRendered \} from '\.\.\/browser\.js'/.test(src));
  check('source defines CHALLENGE_MARKERS with "Just a moment"', /'Just a moment'/.test(src));
  check('source defines CHALLENGE_MARKERS with "challenges.cloudflare.com"', /'challenges\.cloudflare\.com'/.test(src));
  check('_fetchBypassingChallenge falls back to fetchRendered on challenge', /await fetchRendered\(/.test(src));
  check('_fetchBypassingChallenge uses blockResources:false', /blockResources:\s*false/.test(src));
  // Verify CHALLENGE_MARKERS list directly via regex match.
  const markersM = src.match(/const CHALLENGE_MARKERS = \[([^\]]+)\]/);
  check('CHALLENGE_MARKERS has >=3 markers', markersM && (markersM[1].match(/'/g) || []).length >= 6, `(markers=${markersM?.[1]})`);
})();

// ----- TEST 7: fetchCity end-to-end (mocked, page 1 only) -----
console.log('\n[T7] fetchCity end-to-end (mocked, page 1 only)');
(async () => {
  // Stub _fetchBypassingChallenge directly (bypasses the Playwright
  // fetchRendered fallback — not available in the test environment, and
  // not needed for hermetic unit tests since we have the cached HTML).
  const fetchLog = [];
  scraper._fetchBypassingChallenge = async (url) => {
    fetchLog.push(url);
    if (/\/mieszkania\/do-wynajecia\/warszawa\/t\/bez-posrednikow/.test(url) && SEARCH_BEZPOS_HTML) return SEARCH_BEZPOS_HTML;
    if (/\/mieszkania\/do-wynajecia\/warszawa\/?(\?|$)/.test(url) && SEARCH_ALL_HTML) return SEARCH_ALL_HTML;
    if (/\/oferta\/wynajme-mieszkanie-warszawa-wawolnicka/.test(url) && DETAIL_HTML) return DETAIL_HTML;
    // Non-matched URLs (other detail pages) — return null so the enrich
    // step's `try/catch` swallows the error gracefully (the ad keeps its
    // search-blob state and the walk continues).
    return null;
  };
  // Cap pages at 1 so the walk stops after page 1 (we only have one
  // search fixture per feed). The unfiltered feed returns 35 cards on
  // page 1 (= OFFERS_PER_PAGE).
  process.env.GETHOME_MAX_PAGES = '1';
  const ads = await scraper.fetchCity(CITY, { filters: {} });
  delete process.env.GETHOME_MAX_PAGES;
  check('fetchCity returned >0 ads', ads.length > 0, `(got ${ads.length})`);
  check('fetchCity returned 35 ads (OFFERS_PER_PAGE on unfiltered page 1)', ads.length === 35, `(got ${ads.length})`);
  // Detail-page enrichment should have run for at least one listing
  // (Wąwolnicka — the only one with a detail fixture).
  const detailFetches = fetchLog.filter(u => /\/oferta\//.test(u));
  check('detail-page enrichment ran (>=1 fetch)', detailFetches.length >= 1, `(count=${detailFetches.length})`);
  // Verify the first card has full data.
  const a0 = ads[0];
  check('first ad has price', a0.price > 0, `(price=${a0.price})`);
  check('first ad has rooms', a0.rooms != null, `(rooms=${a0.rooms})`);
  check('first ad has area', a0.area != null, `(area=${a0.area})`);
  check('first ad has floor', a0.floor != null, `(floor=${a0.floor})`);
  check('first ad has lat', a0.lat != null, `(lat=${a0.lat})`);
  check('first ad has lng', a0.lng != null, `(lng=${a0.lng})`);
  check('first ad has images (>=5)', a0.images?.length >= 5, `(count=${a0.images?.length})`);
  check('first ad currency=PLN', a0.currency === 'PLN');
  check('first ad sourceId=11', a0.sourceId === 11);
  check('first ad cityId=1', a0.cityId === 1);
  check('first ad url starts https://gethome.pl', a0.url?.startsWith('https://gethome.pl'));
  console.log(`    first ad: price=${a0.price}PLN rooms=${a0.rooms} area=${a0.area}m² floor=${a0.floor} lat=${a0.lat} lng=${a0.lng} images=${a0.images?.length}`);

  // Verify the Wąwolnicka listing got full description enrichment.
  const w = ads.find(a => a.url.includes('wawolnicka'));
  check('Wąwolnicka ad enriched', !!w);
  if (w) {
    check('Wąwolnicka ad has price=4100', w.price === 4100, `(price=${w.price})`);
    check('Wąwolnicka ad has rooms=3', w.rooms === 3, `(rooms=${w.rooms})`);
    check('Wąwolnicka ad has area=64.88', w.area === 64.88, `(area=${w.area})`);
    check('Wąwolnicka ad has floor="2"', w.floor === '2', `(floor=${w.floor})`);
    check('Wąwolnicka ad has lat (refined)', w.lat != null, `(lat=${w.lat})`);
    check('Wąwolnicka ad has lng (refined)', w.lng != null, `(lng=${w.lng})`);
    check('Wáwolnicka ad has enriched description (>=1500 chars)', w.description && w.description.length >= 1500, `(len=${w.description?.length})`);
    check('Wąwolnicka ad has images from search (preserved)', w.images?.length >= 5, `(count=${w.images?.length})`);
    check('Wąwolnicka ad has raw.params populated', w.raw?.params?.length > 0, `(count=${w.raw?.params?.length})`);
    console.log(`    Wąwolnicka ad: price=${w.price}PLN rooms=${w.rooms} area=${w.area}m² floor=${w.floor}`);
    console.log(`    Wąwolnicka desc len: ${w.description?.length} chars`);
    console.log(`    Wąwolnicka images: ${w.images?.length} photos (preserved from search)`);
    console.log(`    Wąwolnicka raw.params: ${w.raw?.params?.length} entries`);
  }
})();

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
if (fail > 0) process.exit(1);
