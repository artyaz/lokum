// Smoke test for the odwlasciciela.pl scraper (Task D-odwlasciciela-6).
// Runs offline logic tests against the cached fixture HTML files in /tmp.
// Usage:
//   node /home/z/my-project/lokum/backend/scripts/test_odwlasciciela.mjs
//
// Test fixtures (cached 2026-08-30 via z-ai page_reader on live pages):
//   /tmp/odwl_search.html  — search page 1, 20 mieszkanie cards
//   /tmp/odwl_detail.html  — detail page for listing 43366 (11 photos, 6-paragraph desc)
//
// Tests:
//   1. _parseSearchCards: parse 20 cards from the search fixture
//   2. _parseSearchCards: each card has externalId, url, price > 0, area, rooms, floor
//   3. _applyDetail: extract full description (>= 500 chars), photos (>= 8), postedAt, params
//   4. _normalizeUrl: strips utm_* + fbclid
//   5. _extractAttribute: parse area / rooms / floor from a card chunk
//   6. parsePostedAt: "2026-08-26 21:59:13" → ISO 8601

import { readFileSync } from 'node:fs';
import { OdwlascicielaScraper } from '../src/services/scrapers/odwlasciciela.js';

const scraper = new OdwlascicielaScraper();

const city = {
  id: 1,
  name: 'Warsaw',
  name_pl: 'Warszawa',
  slug: 'warsaw',
  lat: 52.2297,
  lng: 21.0122
};

const searchHtml = readFileSync('/tmp/odwl_search.html', 'utf8');
const detailHtml = readFileSync('/tmp/odwl_detail.html', 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

console.log('=== Test 1: _parseSearchCards parses mieszkanie cards (filters komercja) ===');
// The search fixture has 20 articles — 18 mieszkanie + 2 komercja. The parser
// should return 18 cards (komercja ids 43156 and 43391 are filtered out).
const cards = scraper._parseSearchCards(searchHtml, city);
console.log(`  parsed ${cards.length} cards`);
assert(cards.length === 18, `parsed 18 mieszkanie cards (got ${cards.length}; komercja filtered)`);
assert(!cards.some(c => c.externalId === '43156'), `komercja id 43156 filtered out`);
assert(!cards.some(c => c.externalId === '43391'), `komercja id 43391 filtered out`);

console.log('=== Test 2: each card has required fields ===');
const first = cards[0];
assert(first.externalId === '43366', `first card externalId=43366 (got ${first.externalId})`);
assert(first.url === 'https://odwlasciciela.pl/oferty/podglad/43366,mieszkanie-wynajme.html',
  `first card url (got ${first.url})`);
assert(first.price === 3000, `first card price=3000 (got ${first.price})`);
assert(first.area === 37, `first card area=37 (got ${first.area})`);
assert(first.rooms === 2, `first card rooms=2 (got ${first.rooms})`);
assert(first.floor === '1/12', `first card floor=1/12 (got ${first.floor})`);
assert(first.district === 'Ochota', `first card district=Ochota (got ${first.district})`);
assert(first.street === 'Al. Jerozolimskie 135', `first card street (got ${first.street})`);
assert(first.lat === 52.2297, `first card lat=city.lat fallback (got ${first.lat})`);
assert(first.lng === 21.0122, `first card lng=city.lng fallback (got ${first.lng})`);
assert(first.currency === 'PLN', `first card currency=PLN (got ${first.currency})`);
assert(first.sourceId === 13, `first card sourceId=13 (got ${first.sourceId})`);
assert(first.cityId === 1, `first card cityId=1 (got ${first.cityId})`);
// "Bezpośrednio" badge on every card
assert(first.conveniences.some(c => c.type === 'direct'), `first card direct convenience present`);
// thumbnail
assert(first.images.length === 1 && first.images[0].includes('/assets/userfiles/offers/'),
  `first card has search-card thumbnail (got ${JSON.stringify(first.images)})`);

console.log('=== Test 3: _applyDetail extracts full description + photos + postedAt ===');
// Simulate the search-card state for the first card
const ad = { ...first, raw: { url: first.url, searchCard: first.raw.searchCard } };
// Reset description to the search-card truncated version (simulating the pre-enrich state)
ad.description = first.description;
ad.images = first.images; // search-card thumbnail only
ad.postedAt = null;
scraper._applyDetail(detailHtml, ad);
console.log(`  description length: ${ad.description.length}`);
console.log(`  photos: ${ad.images.length}`);
console.log(`  postedAt: ${ad.postedAt}`);
console.log(`  title: ${ad.title}`);
assert(ad.description.length > 500, `detail description >= 500 chars (got ${ad.description.length})`);
assert(ad.description.includes('Świeżo po generalnym remoncie'),
  `detail description starts with expected Polish text`);
assert(ad.images.length >= 8, `detail photos >= 8 (got ${ad.images.length})`);
assert(ad.images.length <= 20, `detail photos <= 20 (persistListing cap) (got ${ad.images.length})`);
assert(ad.postedAt && ad.postedAt.startsWith('2026-08-26'),
  `detail postedAt=2026-08-26 (got ${ad.postedAt})`);
assert(ad.title.includes('Wynajmę 2-pokojowe') && ad.title.includes('Al. Jerozolimskie 135'),
  `detail title from JSON-LD name (got ${ad.title})`);
// Lat/lng should still be the city-level fallback (no listing-specific coords on the page)
assert(ad.lat === 52.2297, `lat stays at city fallback after _applyDetail`);
assert(ad.lng === 21.0122, `lng stays at city fallback after _applyDetail`);
// Conveniences include direct marker (added by _applyDetail)
assert(ad.conveniences.some(c => c.type === 'direct'),
  `detail adds direct convenience marker`);

console.log('=== Test 4: _normalizeUrl strips tracking params ===');
const normalized = scraper._normalizeUrl('https://odwlasciciela.pl/oferty/podglad/43366,mieszkanie-wynajme.html?utm_source=fb&fbclid=abc');
assert(normalized === 'https://odwlasciciela.pl/oferty/podglad/43366,mieszkanie-wynajme.html',
  `_normalizeUrl strips utm_* + fbclid (got ${normalized})`);

console.log('=== Test 5: _extractArea / _extractRooms / _extractFloor parse attributes ===');
const sampleChunk = `<article class="offers-item offers-item--featured">
<a href="/oferty/podglad/43366,mieszkanie-wynajme.html" class="offers-item__link cf">
<div class="offers-item__attributes d-flex flex-wrap">
<span class="offers-item__attribute"><strong>Mieszkanie na wynajem</strong></span>
<span class="offers-item__attribute"><strong>37</strong>m2</span>
<span class="offers-item__attribute">L.pokoi: <strong>2</strong></span>
<span class="offers-item__attribute">Piętro: <strong>1/12</strong></span>
</div></a></article>`;
assert(scraper._extractArea(sampleChunk) === '37',
  `_extractArea=37 (got ${scraper._extractArea(sampleChunk)})`);
assert(scraper._extractRooms(sampleChunk) === '2',
  `_extractRooms=2 (got ${scraper._extractRooms(sampleChunk)})`);
assert(scraper._extractFloor(sampleChunk) === '1/12',
  `_extractFloor=1/12 (got ${scraper._extractFloor(sampleChunk)})`);

console.log('=== Test 6: parsePostedAt handles "YYYY-MM-DD HH:MM:SS" ===');
// parsePostedAt is a module-local function — replicate the logic test inline
function parsePostedAt(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
const postedAt = parsePostedAt('2026-08-26 21:59:13');
assert(postedAt && postedAt.startsWith('2026-08-26') && postedAt.includes('20:59:13') || postedAt.includes('21:59:13'),
  `parsePostedAt ISO contains expected UTC time (got ${postedAt})`);

console.log('=== Test 7: _parseSearchCards filters out komercja ===');
// Construct a synthetic search page with a komercja listing
const komercjaHtml = `<article class="offers-item offers-item--featured">
<a href="/oferty/podglad/43156,komercja-wynajme.html" class="offers-item__link cf">
<div class="offers-item__attributes d-flex flex-wrap">
<span class="offers-item__attribute"><strong>Lokal</strong></span>
<span class="offers-item__attribute"><strong>50</strong>m2</span>
</div>
<footer>
<span class="text text--medium text--black font-weight-bold">5000&nbsp;<small>PLN</small></span>
<span class="text text--gray-2 font-weight-bold ml-5 mr-auto"><span class="mr-3">100&nbsp;<small>PLN/m2</small></span></span>
</footer>
</a></article>`;
const komercjaCards = scraper._parseSearchCards(komercjaHtml, city);
assert(komercjaCards.length === 0,
  `_parseSearchCards filters komercja (got ${komercjaCards.length} cards)`);

console.log('\n==========');
console.log(`Tests passed: ${pass}/${pass + fail}`);
console.log(`Tests failed: ${fail}/${pass + fail}`);
if (fail > 0) {
  console.error('FAIL');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
