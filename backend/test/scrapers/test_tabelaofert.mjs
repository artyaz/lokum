// Test for tabelaofert.js scraper — verifies photo, description, coords,
// and search-card extraction against real fetched HTML samples.
//
// Run: cd backend && node test/scrapers/test_tabelaofert.mjs
//
// Test fixtures (raw HTML cached in /tmp, fetched via curl):
//   /tmp/tabela-search.html    — search results page 1 (Warsaw, owner filter)
//                                30 direct-from-owner rent offers (JSON-LD).
//   /tmp/tabela-search-p2c.html — search results page 2 (last page, 16 offers).
//   /tmp/tabela-detail.html    — sample detail page (Wola 36m², 2 rooms, no photos)
//                                used to test the "direct owner has 0 photos"
//                                edge case — brief explicitly allows this.
//   /tmp/tabela-detail2.html   — sample detail page (Wola 50m² Zawiszy, 2 rooms,
//                                ~19 photos in the gallery, 2701-char description).
//
// The scraper's `_fetch` (inherited from BaseScraper) is NOT used — instead
// the test injects the cached HTML directly by patching the instance, so
// the test runs offline and is hermetic.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TabelaofertScraper } from '../../src/services/scrapers/tabelaofert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = '/tmp';

function readHtml(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const SEARCH_HTML   = readHtml(path.join(TMP, 'tabela-search.html'));
const SEARCH_P2_HTML = readHtml(path.join(TMP, 'tabela-search-p2c.html'));
const DETAIL_HTML   = readHtml(path.join(TMP, 'tabela-detail.html'));
const DETAIL2_HTML  = readHtml(path.join(TMP, 'tabela-detail2.html'));

const CITY = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.23, lng: 21.01 };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name} ${extra}`); fail++; }
}

console.log('--- Test: tabelaofert.js scraper ---');

const scraper = new TabelaofertScraper();
const fetched = [];
scraper._fetch = async (url, opts) => {
  fetched.push(url);
  // Search page 1 — return the cached Warsaw owner-filter search HTML.
  if (/\/wynajem\/mieszkania\/warszawa/.test(url) && !/page=2/.test(url) && SEARCH_HTML) return SEARCH_HTML;
  // Search page 2 (last page) — 16 offers.
  if (/\/wynajem\/mieszkania\/warszawa.*page=2/.test(url) && SEARCH_P2_HTML) return SEARCH_P2_HTML;
  // Detail pages — both fixtures have full metadata.
  if (/\/oferta\/mieszkanie-.*,10497928/.test(url) && DETAIL2_HTML) return DETAIL2_HTML;
  if (/\/oferta\/mieszkanie-.*,10499808/.test(url) && DETAIL_HTML) return DETAIL_HTML;
  throw new Error(`test has no fixture for ${url}`);
};

// ----- TEST 1: search-page card extraction (real HTML) -----
console.log('\n[T1] Search page card extraction');
if (SEARCH_HTML) {
  const cards = scraper._parseCards(SEARCH_HTML, CITY);
  check('search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('search returns at least 20 cards', cards.length >= 20, `(got ${cards.length})`);
  check('search returns 30 cards (OFFERS_PER_PAGE)', cards.length === 30, `(got ${cards.length})`);
  const c0 = cards[0] || {};
  check('card has externalId', !!c0.externalId, `(id=${c0.externalId})`);
  check('card externalId matches URL', c0.externalId === '10499808', `(id=${c0.externalId})`);
  check('card has url starting https://tabelaofert.pl', !!c0.url && c0.url.startsWith('https://tabelaofert.pl'), `(url=${c0.url})`);
  check('card url contains /oferta/mieszkanie-', /\/oferta\/mieszkanie-/.test(c0.url || ''));
  check('card has price', c0.price != null && c0.price > 0, `(price=${c0.price})`);
  check('card price is 2500 PLN', c0.price === 2500, `(price=${c0.price})`);
  check('card has rooms', c0.rooms != null, `(rooms=${c0.rooms})`);
  check('card rooms is 2', c0.rooms === 2, `(rooms=${c0.rooms})`);
  check('card has area', c0.area != null && c0.area > 0, `(area=${c0.area})`);
  check('card area is 36', c0.area === 36, `(area=${c0.area})`);
  check('card has floor', c0.floor != null, `(floor=${c0.floor})`);
  check('card floor is "1"', c0.floor === '1', `(floor=${c0.floor})`);
  check('card has district', !!c0.district, `(district=${c0.district})`);
  check('card district is "Wola"', c0.district === 'Wola', `(district=${c0.district})`);
  check('card has lat', c0.lat != null, `(lat=${c0.lat})`);
  check('card has lng', c0.lng != null, `(lng=${c0.lng})`);
  check('card lat plausible Warsaw (52.x)', c0.lat > 52.0 && c0.lat < 52.5, `(lat=${c0.lat})`);
  check('card lng plausible Warsaw (20-21.x)', c0.lng > 20.5 && c0.lng < 21.5, `(lng=${c0.lng})`);
  check('card has currency=PLN', c0.currency === 'PLN');
  check('card has sourceId=12', c0.sourceId === 12);
  check('card has title', !!c0.title);
  console.log(`    first card: id=${c0.externalId} price=${c0.price}PLN rooms=${c0.rooms} area=${c0.area}m2 floor=${c0.floor}`);
  console.log(`    first card url: ${c0.url}`);
  console.log(`    first card district: ${c0.district}`);
  console.log(`    first card lat/lng: ${c0.lat} / ${c0.lng}`);

  // Verify a card with a street name (the Myśliborska Białołęka listing).
  const c1 = cards.find(c => c.externalId === '10499478');
  check('card 10499478 found', !!c1);
  if (c1) {
    check('card 10499478 has street=Myśliborska', c1.street === 'Myśliborska', `(street=${c1.street})`);
    check('card 10499478 district=Białołęka', c1.district === 'Białołęka', `(district=${c1.district})`);
    check('card 10499478 rooms=1', c1.rooms === 1, `(rooms=${c1.rooms})`);
    check('card 10499478 floor=0 (parter)', c1.floor === '0', `(floor=${c1.floor})`);
  }

  // Verify the Zawiszy Wola listing (richer description).
  const c2 = cards.find(c => c.externalId === '10497928');
  check('card 10497928 found', !!c2);
  if (c2) {
    check('card 10497928 price=3700', c2.price === 3700, `(price=${c2.price})`);
    check('card 10497928 area=50', c2.area === 50, `(area=${c2.area})`);
    check('card 10497928 rooms=2', c2.rooms === 2, `(rooms=${c2.rooms})`);
    check('card 10497928 floor=0', c2.floor === '0', `(floor=${c2.floor})`);
    check('card 10497928 has search-description fallback', !!c2.description, `(desc len=${c2.description?.length})`);
  }
} else {
  console.log('    (skipped - no /tmp/tabela-search.html fixture)');
}

// ----- TEST 2: search page 2 (short page — last page edge case) -----
console.log('\n[T2] Search page 2 (short page / last page)');
if (SEARCH_P2_HTML) {
  const cards = scraper._parseCards(SEARCH_P2_HTML, CITY);
  check('page 2 returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('page 2 returns 16 cards (last page)', cards.length === 16, `(got ${cards.length})`);
  // 16 < OFFERS_PER_PAGE (30), but > SHORT_PAGE_THRESHOLD (15) — borderline.
  // We test that the card parser handles short pages correctly.
  if (cards.length) {
    const c0 = cards[0];
    check('page 2 card has externalId', !!c0.externalId);
    check('page 2 card has price', c0.price > 0, `(price=${c0.price})`);
    check('page 2 card has lat/lng', c0.lat != null && c0.lng != null, `(lat=${c0.lat},lng=${c0.lng})`);
  }
} else {
  console.log('    (skipped - no /tmp/tabela-search-p2c.html fixture)');
}

// ----- TEST 3: detail-page photo extraction (Zawiszy Wola fixture) -----
console.log('\n[T3] Detail-page photo extraction (Zawiszy Wola — 19 photos)');
if (DETAIL2_HTML) {
  const ad = {
    externalId: '10497928',
    price: 3700, currency: 'PLN',
    images: [], raw: { url: 'https://tabelaofert.pl/oferta/mieszkanie-dwupokojowe-do-wynajecia-zawiszy-warszawa-wola,10497928' },
    description: '', postedAt: null,
    conveniences: []
  };
  scraper._applyDetail(DETAIL2_HTML, ad);
  check('photos returned', Array.isArray(ad.images) && ad.images.length > 0, `(got ${ad.images?.length})`);
  check('photos count >= 5', ad.images.length >= 5, `(got ${ad.images.length})`);
  check('photos count >= 8 (target)', ad.images.length >= 8, `(got ${ad.images.length})`);
  check('photo url starts https://', ad.images.every(u => u.startsWith('https://')), `(sample=${ad.images?.[0]})`);
  check('photo url on content.tabelaofert.pl CDN', ad.images.every(u => u.includes('content.tabelaofert.pl')), `(sample=${ad.images?.[0]})`);
  check('photo url ends with .webp', ad.images.every(u => /\.webp$/i.test(u)), `(sample=${ad.images?.[0]})`);
  // canonicalPhotoUrl strips the variant prefix, so the URL should be in
  // the bare-agency-id form (no `quality_80,scale_...` prefix).
  check('photo url has canonical (no-variant) form', ad.images.every(u => /\/\d+-\/import\//.test(u)), `(sample=${ad.images?.[0]})`);
  // No /no_person.png or no-photo.webp should slip through.
  check('no agent-avatar URLs', ad.images.every(u => !/no_person/i.test(u)));
  check('no no-photo placeholder URLs', ad.images.every(u => !/no-photo/i.test(u)));
  console.log(`    extracted ${ad.images.length} photos:`);
  ad.images.slice(0, 3).forEach(u => console.log(`      - ${u}`));
  if (ad.images.length > 3) console.log(`      ... +${ad.images.length - 3} more`);
} else {
  console.log('    (skipped - no /tmp/tabela-detail2.html fixture)');
}

// ----- TEST 4: detail-page description extraction -----
console.log('\n[T4] Detail-page description extraction');
if (DETAIL2_HTML) {
  const ad = {
    externalId: '10497928',
    price: 3700, currency: 'PLN',
    images: [], raw: {}, description: 'short fallback', postedAt: null,
    conveniences: []
  };
  scraper._applyDetail(DETAIL2_HTML, ad);
  check('description returned', !!ad.description, `(len=${ad.description?.length})`);
  check('description length >= 500', ad.description && ad.description.length >= 500, `(len=${ad.description?.length})`);
  check('description length >= 1500 (target)', ad.description && ad.description.length >= 1500, `(len=${ad.description?.length})`);
  check('description is Polish (contains mieszkanie/zł/wynaj)', /mieszkanie|zł|wynaj/i.test(ad.description || ''));
  check('description has newlines from <br>', (ad.description || '').includes('\n'));
  check('description contains "BEZPOŚREDNIE - BEZ PROWIZJI" (direct marker)', /BEZPOŚREDNIE - BEZ PROWIZJI/.test(ad.description || ''));
  console.log(`    description length: ${ad.description?.length} chars`);
  console.log(`    first 200: ${(ad.description || '').slice(0, 200)}`);
  console.log(`    last 200: ${(ad.description || '').slice(-200)}`);
} else {
  console.log('    (skipped - no /tmp/tabela-detail2.html fixture)');
}

// ----- TEST 5: detail-page no-photo edge case (Wola 36m² fixture) -----
console.log('\n[T5] Detail-page no-photo edge case (Wola 36m² — direct owner, 0 photos)');
if (DETAIL_HTML) {
  const ad = {
    externalId: '10499808',
    price: 2500, currency: 'PLN',
    images: [], raw: {}, description: '', postedAt: null,
    conveniences: []
  };
  scraper._applyDetail(DETAIL_HTML, ad);
  check('images array present', Array.isArray(ad.images));
  check('images empty (no-photo listing)', ad.images.length === 0, `(got ${ad.images.length})`);
  check('description returned (still extractable)', !!ad.description, `(len=${ad.description?.length})`);
  check('description length >= 300', ad.description && ad.description.length >= 300, `(len=${ad.description?.length})`);
  console.log(`    description length: ${ad.description?.length} chars`);
  console.log(`    images: ${ad.images.length}`);
} else {
  console.log('    (skipped - no /tmp/tabela-detail.html fixture)');
}

// ----- TEST 6: detail-page additionalProperty → conveniences -----
console.log('\n[T6] Detail-page additionalProperty → conveniences');
if (DETAIL2_HTML) {
  const ad = {
    externalId: '10497928',
    price: 3700, currency: 'PLN',
    images: [], raw: {}, description: '', postedAt: null,
    conveniences: []
  };
  scraper._applyDetail(DETAIL2_HTML, ad);
  check('conveniences array present', Array.isArray(ad.conveniences));
  check('at least 1 convenience extracted', ad.conveniences.length >= 1, `(count=${ad.conveniences.length})`);
  // The Zawiszy fixture has additionalProperty: Powierzchnie zewnętrzne=balkon
  // (should give us a balcony convenience) and brand.name="Oferta bezpośrednia"
  // (direct marker convenience).
  const hasDirect = ad.conveniences.some(c => c.type === 'direct');
  check('convenience: Bez pośredników (direct) marker', hasDirect, `(convs=${JSON.stringify(ad.conveniences)})`);
  const hasBalcony = ad.conveniences.some(c => c.type === 'balcony');
  check('convenience: Balcony', hasBalcony, `(convs=${JSON.stringify(ad.conveniences)})`);
  check('raw.params has Typ budynku', ad.raw?.params?.some(p => p.name === 'Typ budynku'));
  check('raw.params has Rok Budowy', ad.raw?.params?.some(p => p.name === 'Rok Budowy'));
  console.log(`    conveniences: ${JSON.stringify(ad.conveniences)}`);
  console.log(`    params: ${ad.raw?.params?.length} entries`);
} else {
  console.log('    (skipped - no /tmp/tabela-detail2.html fixture)');
}

// ----- TEST 7: parsePostedAt + canonicalPhotoUrl (unit-level) -----
console.log('\n[T7] parsePostedAt + canonicalPhotoUrl');

// parsePostedAt is module-private; test indirectly via _applyDetail on a
// fragment we construct. The Zawiszy fixture's params list has
// "Data dodania</p><p class=\"t_ptJTzb\">2026-08-27" — let's verify.
//
// IMPORTANT: use a FRESH scraper instance here so the unit-level _applyDetail
// call doesn't poison the prototype method on the shared `scraper` instance
// that T10's fetchCity end-to-end test needs (an earlier draft stubbed out
// scraper._applyDetail here, which silently broke T10 enrichment).
const fragment = '<ul><li class="t_-deJfz"><p class="t_oTeawX">Ogrzewanie</p><p class="t_ptJTzb">c.o. miejskie</p></li><li class="t_-deJfz"><p class="t_oTeawX">Data dodania</p><p class="t_ptJTzb">2026-08-27</p></li></ul>';
const ad7b = { externalId: 'x', images: [], raw: {}, description: '', postedAt: null, conveniences: [] };
const freshScraper = new TabelaofertScraper();
freshScraper._applyDetail(fragment, ad7b);
check('postedAt extracted from fragment', !!ad7b.postedAt, `(postedAt=${ad7b.postedAt})`);
if (ad7b.postedAt) {
  check('postedAt is 2026-08-27', ad7b.postedAt.startsWith('2026-08-27'), `(postedAt=${ad7b.postedAt})`);
}

// ----- TEST 8: _normalizeUrl -----
console.log('\n[T8] _normalizeUrl');
const u1 = scraper._normalizeUrl('https://tabelaofert.pl/oferta/mieszkanie-x,10499808?utm_source=fb&fbclid=abc123');
check('strips utm_ and fbclid params', /utm_|fbclid/.test(u1) === false, `(url=${u1})`);
check('preserves path + listing id', /mieszkanie-x,10499808$/.test(u1), `(url=${u1})`);
const u2 = scraper._normalizeUrl('https://tabelaofert.pl/oferta/mieszkanie-x,10499808');
check('clean url unchanged', u2 === 'https://tabelaofert.pl/oferta/mieszkanie-x,10499808', `(url=${u2})`);
const u3 = scraper._normalizeUrl(null);
check('null url returns null', u3 === null);
// The klient_typ=osoba_prywatna param is NOT a tracking param — keep it.
const u4 = scraper._normalizeUrl('https://tabelaofert.pl/wynajem/mieszkania/warszawa?klient_typ=osoba_prywatna&page=2');
check('preserves klient_typ + page params (non-tracking)', /klient_typ=osoba_prywatna/.test(u4) && /page=2/.test(u4), `(url=${u4})`);

// ----- TEST 9: Source registration sanity -----
console.log('\n[T9] Source registration sanity');
check('scraper sourceId=12', scraper.sourceId === 12);
check('scraper sourceSlug=tabelaofert', scraper.sourceSlug === 'tabelaofert');
check('scraper baseUrl=https://tabelaofert.pl', scraper.baseUrl === 'https://tabelaofert.pl');
check('scraper supportsStreaming=false', scraper.supportsStreaming === false);

// ----- TEST 10: fetchCity end-to-end (mocked) -----
console.log('\n[T10] fetchCity end-to-end (mocked)');
(async () => {
  // Reset the fetch mock to track detail-page fetches during enrichment.
  const fetchLog = [];
  scraper._fetch = async (url, opts) => {
    fetchLog.push(url);
    if (/\/wynajem\/mieszkania\/warszawa/.test(url) && !/page=2/.test(url) && SEARCH_HTML) return SEARCH_HTML;
    if (/\/wynajem\/mieszkania\/warszawa.*page=2/.test(url) && SEARCH_P2_HTML) return SEARCH_P2_HTML;
    if (/\/oferta\/mieszkanie-.*,10497928/.test(url) && DETAIL2_HTML) return DETAIL2_HTML;
    if (/\/oferta\/mieszkanie-.*,10499808/.test(url) && DETAIL_HTML) return DETAIL_HTML;
    throw new Error(`test fetchCity mock has no fixture for ${url}`);
  };
  // Use TABELAOFERT_MAX_PAGES=2 to stop after page 2 (last page).
  process.env.TABELAOFERT_MAX_PAGES = '2';
  const ads = await scraper.fetchCity(CITY, { filters: {}, sinceTime: null });
  delete process.env.TABELAOFERT_MAX_PAGES;
  check('fetchCity returned >0 ads', ads.length > 0, `(got ${ads.length})`);
  check('fetchCity returned 30+16=46 cards (page 1 + page 2)', ads.length === 46, `(got ${ads.length})`);
  // Enrichment should have fetched detail pages for at least one listing.
  const detailFetches = fetchLog.filter(u => /\/oferta\/mieszkanie-/.test(u));
  check('detail-page enrichment ran (>=1 fetch)', detailFetches.length >= 1, `(count=${detailFetches.length})`);
  // Find the enriched Zawiszy listing (10497928).
  const z = ads.find(a => a.externalId === '10497928');
  check('Zawiszy ad enriched', !!z);
  if (z) {
    check('Zawiszy ad has price=3700', z.price === 3700, `(price=${z.price})`);
    check('Zawiszy ad has area=50', z.area === 50, `(area=${z.area})`);
    check('Zawiszy ad has rooms=2', z.rooms === 2, `(rooms=${z.rooms})`);
    check('Zawiszy ad has floor=0', z.floor === '0', `(floor=${z.floor})`);
    check('Zawiszy ad has lat', z.lat != null, `(lat=${z.lat})`);
    check('Zawiszy ad has lng', z.lng != null, `(lng=${z.lng})`);
    check('Zawiszy ad has description (enriched, >500 chars)', z.description && z.description.length > 500, `(len=${z.description?.length})`);
    check('Zawiszy ad has images (>=5)', z.images && z.images.length >= 5, `(count=${z.images?.length})`);
    check('Zawiszy ad has conveniences (>=1)', z.conveniences && z.conveniences.length >= 1, `(count=${z.conveniences?.length})`);
    check('Zawiszy ad has direct marker convenience', z.conveniences?.some(c => c.type === 'direct'));
    check('Zawiszy ad currency=PLN', z.currency === 'PLN');
    check('Zawiszy ad sourceId=12', z.sourceId === 12);
    check('Zawiszy ad url starts https://tabelaofert.pl', z.url?.startsWith('https://tabelaofert.pl'));
    check('Zawiszy ad has cityId=1', z.cityId === 1);
    console.log(`    Zawiszy ad: price=${z.price}PLN rooms=${z.rooms} area=${z.area}m² floor=${z.floor} lat=${z.lat} lng=${z.lng}`);
    console.log(`    Zawiszy images: ${z.images?.length} photos`);
    console.log(`    Zawiszy desc len: ${z.description?.length} chars`);
    console.log(`    Zawiszy conveniences: ${JSON.stringify(z.conveniences)}`);
  }
  // And verify the no-photo listing (10499808) still got enriched description.
  const n = ads.find(a => a.externalId === '10499808');
  check('no-photo ad enriched', !!n);
  if (n) {
    check('no-photo ad has description (>=300 chars)', n.description && n.description.length >= 300, `(len=${n.description?.length})`);
    check('no-photo ad has 0 images (direct owner)', n.images?.length === 0, `(count=${n.images?.length})`);
    check('no-photo ad has lat/lng (from search JSON-LD)', n.lat != null && n.lng != null, `(lat=${n.lat},lng=${n.lng})`);
  }
})();

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
if (fail > 0) process.exit(1);
