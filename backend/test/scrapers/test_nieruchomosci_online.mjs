// Test for nieruchomosciOnline.js scraper — verifies photo, description,
// coords, and search-card extraction against real fetched HTML samples.
//
// Run: cd backend && node test/scrapers/test_nieruchomosci_online.mjs
//
// Test fixtures live in /tmp (downloaded via `z-ai function -n page_reader`):
//   /tmp/no-search.json — page_reader output for the Warsaw rental search page
//   /tmp/no-detail.json — page_reader output for a sample listing detail page
//   /tmp/no-detail2.json — page_reader output for an 8-photo listing
//
// The scraper's `_fetch` (inherited from BaseScraper) is NOT used — instead
// the test injects the cached HTML directly by patching the instance, so
// the test runs offline and is hermetic.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NieruchomosciOnlineScraper } from '../../src/services/scrapers/nieruchomosciOnline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = '/tmp';

function readPageReaderJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const obj = JSON.parse(raw);
  // The page_reader returns { code, status, data: { html, title, ... } }
  return obj?.data?.html || obj?.html || '';
}

const SEARCH_HTML = fs.existsSync(path.join(TMP, 'no-search.json'))
  ? readPageReaderJson(path.join(TMP, 'no-search.json'))
  : null;
const DETAIL_HTML = fs.existsSync(path.join(TMP, 'no-detail.json'))
  ? readPageReaderJson(path.join(TMP, 'no-detail.json'))
  : null;
const DETAIL2_HTML = fs.existsSync(path.join(TMP, 'no-detail2.json'))
  ? readPageReaderJson(path.join(TMP, 'no-detail2.json'))
  : null;

const CITY = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.23, lng: 21.01 };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name} ${extra}`); fail++; }
}

console.log('--- Test: nieruchomosciOnline.js scraper ---');

// Build a mock scraper instance with the _fetch method stubbed to return
// our cached HTML, so the test runs without network access.
const scraper = new NieruchomosciOnlineScraper();
const fetched = [];
scraper._fetch = async (url, opts) => {
  fetched.push(url);
  if (url.includes('mieszkania,wynajem') && SEARCH_HTML) return SEARCH_HTML;
  // Any detail-page URL returns one of our cached detail HTML fixtures so
  // the e2e test (T8) can verify the enrichment path without network.
  // The first cached detail (26928915) has 7 photos; the second (26867167)
  // has 8 photos — both have lat/lng. We match on the /mieszkanie prefix
  // (with comma OR hyphen, depending on listing slug).
  if (/\/mieszkanie[,/-]/.test(url) && DETAIL_HTML) return DETAIL_HTML;
  throw new Error(`test has no fixture for ${url}`);
};

// ----- TEST 1: search-page card extraction (real HTML) -----
console.log('\n[T1] Search page card extraction');
if (SEARCH_HTML) {
  const cards = scraper._parseSearchCards(SEARCH_HTML, CITY);
  check('search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
  check('search returns >=20 cards', cards.length >= 20, `(got ${cards.length})`);
  const c0 = cards[0] || {};
  check('card has externalId', !!c0.id, `(id=${c0.id})`);
  check('card has url', !!c0.url && c0.url.startsWith('http'), `(url=${c0.url})`);
  check('card has price', c0.price != null && c0.price > 0, `(price=${c0.price})`);
  check('card has rooms', c0.rooms != null, `(rooms=${c0.rooms})`);
  check('card has area', c0.area != null && c0.area > 0, `(area=${c0.area})`);
  check('card url matches detail pattern', /mieszkanie,[^/]+\/\d+\.html$/.test(c0.url || ''), `(url=${c0.url})`);
  console.log(`    first card: id=${c0.id} price=${c0.price}PLN rooms=${c0.rooms} area=${c0.area}m2`);
  console.log(`    first card url: ${c0.url}`);
} else {
  console.log('    (skipped - no /tmp/no-search.json fixture; run `z-ai function -n page_reader -a \'{"url":"https://warszawa.nieruchomosci-online.pl/mieszkania,wynajem"}\' -o /tmp/no-search.json` first)');
}

// ----- TEST 2: photo extraction from inline JS (real HTML) -----
console.log('\n[T2] Detail-page photo extraction');
if (DETAIL_HTML) {
  const photos = scraper._extractPhotosFromJs(DETAIL_HTML);
  check('photos returned', Array.isArray(photos) && photos.length > 0, `(got ${photos.length})`);
  check('photos count >= 5', photos.length >= 5, `(got ${photos.length})`);
  // The 26928915 fixture has 7 photos (just under the 8-12 target); the
  // 26867167 fixture has 8 photos. The site's actual photo count is what
  // the agent uploaded; we extract ALL of them, no truncation.
  check('photos count >= 7 (listing 26928915 has 7)', photos.length >= 7, `(got ${photos.length})`);
  check('photo url is https', photos.every(u => u.startsWith('https://')), `(sample=${photos[0]})`);
  check('photo url on correct CDN', photos.every(u => u.includes('st-nieruchomosci-online.pl')), `(sample=${photos[0]})`);
  console.log(`    extracted ${photos.length} photos:`);
  photos.slice(0, 3).forEach(u => console.log(`      - ${u}`));
  if (photos.length > 3) console.log(`      ... +${photos.length - 3} more`);
}
if (DETAIL2_HTML) {
  const photos2 = scraper._extractPhotosFromJs(DETAIL2_HTML);
  check('detail2 photos >= 8', photos2.length >= 8, `(got ${photos2.length})`);
  console.log(`    second listing extracted ${photos2.length} photos`);
}

// ----- TEST 3: full description extraction (real HTML) -----
console.log('\n[T3] Detail-page description extraction');
if (DETAIL_HTML) {
  const desc = scraper._extractFullDescription(DETAIL_HTML);
  check('description returned', !!desc, `(len=${desc?.length})`);
  check('description length >= 100', desc && desc.length >= 100, `(len=${desc?.length})`);
  check('description is Polish (contains mieszkanie/zl/wynaj)',
    /mieszkanie|zł|wynaj|pokój|sypialn/i.test(desc || ''), `(sample=${desc?.slice(0,80)})`);
  check('description has newlines (multi-line)', (desc?.match(/\n/g) || []).length > 0, '(no newlines)');
  console.log(`    description (first 200 chars): ${(desc || '').slice(0, 200).replace(/\n/g, ' / ')}`);
}
if (DETAIL2_HTML) {
  const desc2 = scraper._extractFullDescription(DETAIL2_HTML);
  check('detail2 description longer than JSON-LD summary',
    desc2 && desc2.length > 200, `(len=${desc2?.length})`);
  // Verify the full text contains info that's only in the desc-more div
  check('detail2 description contains truncated content (e.g. "Mieszkanie idealne")',
    /Mieszkanie idealne|Umowa najmu|kaucja/i.test(desc2 || ''), `(sample=${desc2?.slice(0,200)})`);
}

// ----- TEST 4: Apartment JSON-LD block extraction (lat/lng, price, etc.) -----
console.log('\n[T4] Apartment JSON-LD block extraction');
if (DETAIL_HTML) {
  const apt = scraper._extractApartmentBlock(DETAIL_HTML);
  check('Apartment block found', !!apt, '(no Apartment block)');
  if (apt) {
    check('geo present', !!apt.geo, '(no geo)');
    check('lat present', apt.geo?.latitude != null, `(lat=${apt.geo?.latitude})`);
    check('lng present', apt.geo?.longitude != null, `(lng=${apt.geo?.longitude})`);
    check('lat is plausible (49-55)', apt.geo && Number(apt.geo.latitude) > 49 && Number(apt.geo.latitude) < 55, `(lat=${apt.geo?.latitude})`);
    check('lng is plausible (14-24)', apt.geo && Number(apt.geo.longitude) > 14 && Number(apt.geo.longitude) < 24, `(lng=${apt.geo?.longitude})`);
    check('address.streetAddress present', !!apt.address?.streetAddress, `(street=${apt.address?.streetAddress})`);
    check('offers[0].price present', apt.offers?.[0]?.price != null, `(price=${apt.offers?.[0]?.price})`);
    check('numberOfRooms present', apt.numberOfRooms != null, `(rooms=${apt.numberOfRooms})`);
    check('floorLevel present', apt.floorLevel != null, `(floor=${apt.floorLevel})`);
    check('floorSize present', apt.floorSize?.value != null, `(area=${apt.floorSize?.value})`);
    check('datePosted present', !!apt.datePosted, `(date=${apt.datePosted})`);
    console.log(`    Apartment: ${apt.numberOfRooms} rooms, ${apt.floorSize?.value} m2, floor ${apt.floorLevel}, ${apt.offers?.[0]?.price} PLN, lat=${apt.geo?.latitude}, lng=${apt.geo?.longitude}, posted=${apt.datePosted}`);
  }
}

// ----- TEST 5: postedAt date parser -----
console.log('\n[T5] datePosted parser');
const iso1 = scraper._parsePostedAt('2026-08-28CEST16:47:24Z');
check('parses CEST-injected date', iso1 && iso1.startsWith('2026-08-28'), `(iso=${iso1})`);
const iso2 = scraper._parsePostedAt('2026-08-28');
check('parses bare date', iso2 && iso2.startsWith('2026-08-28'), `(iso=${iso2})`);
const iso3 = scraper._parsePostedAt(null);
check('null input -> null output', iso3 === null, `(got=${iso3})`);

// ----- TEST 6: externalId extraction from URL -----
console.log('\n[T6] externalId extraction');
const id1 = scraper._extractIdFromUrl('https://warszawa.nieruchomosci-online.pl/mieszkanie,na-wynajem/26928915.html');
check('id=26928915', id1 === '26928915', `(got=${id1})`);
const id2 = scraper._extractIdFromUrl('https://warszawa.nieruchomosci-online.pl/mieszkanie,m2,z-aneksem-kuchennym/26619599.html');
check('id=26619599', id2 === '26619599', `(got=${id2})`);
const id3 = scraper._extractIdFromUrl('not-a-url');
check('garbage input -> null', id3 === null, `(got=${id3})`);

// ----- TEST 7: _normalizeUrl strips utm params -----
console.log('\n[T7] _normalizeUrl');
const n1 = scraper._normalizeUrl('https://warszawa.nieruchomosci-online.pl/mieszkanie,na-wynajem/26928915.html?utm_source=foo&fbclid=abc');
check('strips utm + fbclid', n1 && !n1.includes('utm') && !n1.includes('fbclid'), `(got=${n1})`);
const n2 = scraper._normalizeUrl('https://warszawa.nieruchomosci-online.pl/mieszkanie,na-wynajem/26928915.html');
check('clean url unchanged', n2 && n2.endsWith('26928915.html'), `(got=${n2})`);

// ----- TEST 8: end-to-end fetchCity (with mocked _fetch) -----
console.log('\n[T8] fetchCity end-to-end (mocked _fetch)');
if (SEARCH_HTML && DETAIL_HTML) {
  // Force only ONE page and limit enrichment to the first card to keep
  // the test fast — patch scraper internals via env var.
  process.env.NO_MAX_PAGES = '1';
  const ads = await scraper.fetchCity(CITY, { filters: {} });
  process.env.NO_MAX_PAGES = '';
  check('fetchCity returned ads', Array.isArray(ads) && ads.length > 0, `(got ${ads?.length})`);
  if (ads.length) {
    const a0 = ads[0];
    check('ad has externalId', !!a0.externalId);
    check('ad has sourceId=8', a0.sourceId === 8);
    check('ad has url', !!a0.url);
    check('ad has price > 0', a0.price > 0, `(price=${a0.price})`);
    check('ad has rooms', a0.rooms != null);
    check('ad has area', a0.area != null);
    check('ad has images', Array.isArray(a0.images) && a0.images.length > 0, `(got ${a0.images?.length})`);
    check('ad has description', !!a0.description && a0.description.length > 0, `(len=${a0.description?.length})`);
    check('ad has lat', a0.lat != null, `(lat=${a0.lat})`);
    check('ad has lng', a0.lng != null, `(lng=${a0.lng})`);
    check('ad lat is plausible', a0.lat > 49 && a0.lat < 55, `(lat=${a0.lat})`);
    check('ad lng is plausible', a0.lng > 14 && a0.lng < 24, `(lng=${a0.lng})`);
    console.log(`    first ad: id=${a0.externalId} price=${a0.price}PLN rooms=${a0.rooms} area=${a0.area}m2`);
    console.log(`    photos: ${a0.images?.length}, lat=${a0.lat}, lng=${a0.lng}`);
    console.log(`    description first 100 chars: ${(a0.description || '').slice(0, 100).replace(/\n/g, ' / ')}`);
  }
} else {
  console.log('    (skipped - needs /tmp/no-search.json + /tmp/no-detail.json)');
}

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
process.exit(fail ? 1 : 0);
