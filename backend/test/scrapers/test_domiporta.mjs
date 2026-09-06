// Test for domiporta.js scraper — verifies photo, description, coords,
// and search-card extraction against real fetched HTML samples.
//
// Run: cd backend && node test/scrapers/test_domiporta.mjs
//
// Test fixtures (raw HTML cached in /tmp, fetched via curl + z-ai page_reader):
//   /tmp/domiporta-search.html  — search results page (Warszawa, page 1)
//                                  36 ItemList cards, mixed sale+rent (all rent).
//   /tmp/domiporta-detail1.html — sample detail page (Śródmieście Rycerska, 48 m²,
//                                  2 rooms, 8 photos, lat=52.249, lng=21.010)
//   /tmp/domiporta-detail2.html — sample detail page (Mokotów Konstancińska, 98 m²,
//                                  5 rooms, 5 photos, lat=52.186, lng=21.059)
//
// If the real fixtures are missing, the test falls back to a synthetic search
// HTML string (inline below) so the photo-extraction path can still be
// verified offline.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomiportaScraper } from '../../src/services/scrapers/domiporta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = '/tmp';

function readHtml(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const SEARCH_HTML  = readHtml(path.join(TMP, 'domiporta-search.html'));
const DETAIL_HTML  = readHtml(path.join(TMP, 'domiporta-detail1.html'));
const DETAIL2_HTML = readHtml(path.join(TMP, 'domiporta-detail2.html'));

// Synthetic minimal search HTML — mimics the domiporta ItemList JSON-LD
// shape with TWO listings so the photo extraction path can be tested even
// when the real fixture is unavailable. The full Polish description lives
// in `<div class="description__panel">`.
const SYNTHETIC_SEARCH_HTML = `<!doctype html><html lang="pl"><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Mieszkania na wynajem Warszawa - Domiporta.pl","url":"https://www.domiporta.pl/mieszkanie/wynajme/mazowieckie/warszawa"},
  {"@type":"ItemList","itemListElement":[
    {"@type":"ListItem","position":1,"item":{
      "@type":["Product","RealEstateListing"],
      "name":"Mieszkanie 48 m² na Starym Mieście Warszawa - zapraszam: Warszawa Śródmieście: Rycerska",
      "description":" Klimatyczne mieszkanie na obszarze Starego Miasta...",
      "image":"https://galeria.domiporta.pl/pictures/big/13/28/0e/0e28c51882f275edc0241e91cf386ea3154e1a5f/mieszkanie_48_m_na_starym_miescie_warszawa.jpg",
      "datePosted":"2026-08-02",
      "offers":{"@type":"Offer","price":4500.0,"priceCurrency":"PLN","availability":"https://schema.org/InStock","priceSpecification":{"@type":"UnitPriceSpecification","price":93.75,"priceCurrency":"PLN","referenceQuantity":{"@type":"QuantitativeValue","value":1.0}},"itemOffered":{"@type":"Accommodation","numberOfRooms":2,"floorSize":{"@type":"QuantitativeValue","value":48.0},"address":{"@type":"PostalAddress","addressLocality":"Warszawa","addressRegion":"Mazowieckie","streetAddress":"Rycerska","addressCountry":"PL"}},"seller":{"@type":"Organization","name":"AD. DRĄGOWSKI","brand":"AD. DRĄGOWSKI","logo":"20036.jpeg"}},
      "url":"https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754"
    }},
    {"@type":"ListItem","position":2,"item":{
      "@type":["Product","RealEstateListing"],
      "name":"Na wynajem przestronne 98,5 m² na Mokotowie z balkonem: Warszawa Mokotów: Konstancińska",
      "description":"Sadyba I Ciche I Zieleń I Miejsce postojowe...",
      "image":"https://galeria.domiporta.pl/pictures/big/10/42/2c/2c420e6195633ce56aac2cea50ac5d2129ec0231/na_wynajem_przestronne_985_m_na_mokotowie_z_balkonem.jpg",
      "datePosted":"2026-08-20",
      "offers":{"@type":"Offer","price":3313.0,"priceCurrency":"PLN","availability":"https://schema.org/InStock","priceSpecification":{"@type":"UnitPriceSpecification","price":33.6345,"priceCurrency":"PLN","referenceQuantity":{"@type":"QuantitativeValue","value":1.0}},"itemOffered":{"@type":"Accommodation","numberOfRooms":5,"floorSize":{"@type":"QuantitativeValue","value":98.5},"address":{"@type":"PostalAddress","addressLocality":"Warszawa","addressRegion":"Mazowieckie","streetAddress":"Konstancińska","addressCountry":"PL"}},"seller":{"@type":"Organization","name":"AD. DRĄGOWSKI","brand":"AD. DRĄGOWSKI","logo":"20036.jpeg"}},
      "url":"https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-warszawa-mokotow-konstancinska-98m2/156759802"
    }}
  ]}
]}
</script>
</head><body></body></html>`;

// Synthetic detail HTML — mimics a domiporta listing detail page with
// RealEstateListing JSON-LD (geo, image[], floorLevel) + a description__panel
// div containing the full Polish description. Used to test the photo
// extraction path when real fixtures aren't available.
const SYNTHETIC_DETAIL_HTML = `<!doctype html><html lang="pl"><head>
<meta charset="utf-8">
<title>Mieszkanie 48 m² na Starym Mieście Warszawa - zapraszam</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"RealEstateListing","name":"Mieszkanie 48 m² na Starym Mieście Warszawa - zapraszam: Warszawa Śródmieście: Rycerska","description":" Lokalizacja  Klimatyczne mieszkanie na obszarze Starego Miasta przy murach obronnych średniowiecznej Warszawy, w sąsiedztwie Zamku Królewskiego, Kolumny Zygmunta, Pomnika Jana Kilińskiego, Barbakanu, licznych muzeów i...","datePosted":"2026-08-02","url":"https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754","mainEntityOfPage":"https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754","image":["https://galeria.domiporta.pl/pictures/big/13/28/0e/0e28c51882f275edc0241e91cf386ea3154e1a5f/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/18/c3/11/11c38316e2e94dca6bd34d222ab036e65b3c598d/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/15/f1/8f/8ff1e9954f377acc3344af5ca4af7e3548d8a092/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/10/80/42/428008c48e79b5bde6e807a46779a853d1c78522/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/13/31/94/943133440abe5f3927d85d3421a059eff796622b/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/14/de/cb/cbdede306c4ba86db840164845a048229426bb42/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/14/92/47/479249581d3f5440e0943eace361772123b75766/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg","https://galeria.domiporta.pl/pictures/big/19/2c/de/de2c960b827b50d8a672e5ab49efcab8b1dd68c7/mieszkanie_48_m_na_starym_miescie_warszawa_-_zapraszam.jpg"],"address":{"@type":"PostalAddress","addressLocality":"Warszawa","addressRegion":"Mazowieckie","streetAddress":"Rycerska","addressCountry":"PL"},"offers":{"@type":"Offer","priceCurrency":"PLN","price":"4500","availability":"https://schema.org/InStock","url":"https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754"},"seller":{"@type":"RealEstateAgent","name":"AD. DRĄGOWSKI"},"itemOffered":{"@type":"Apartment","yearBuilt":1953,"floorLevel":"1","floorSize":{"@type":"QuantitativeValue","value":48,"unitCode":"MTR"},"amenityFeature":[{"@type":"LocationFeatureSpecification","name":"ogrzewanie miejskie","value":true},{"@type":"LocationFeatureSpecification","name":"umeblowane","value":true}],"geo":{"@type":"GeoCoordinates","latitude":52.2490093,"longitude":21.010237},"additionalProperty":[{"@type":"PropertyValue","name":"Liczba pięter w budynku","value":2},{"@type":"PropertyValue","name":"Forma własności","value":"własność"},{"@type":"PropertyValue","name":"Materiał","value":"cegła"},{"@type":"PropertyValue","name":"Typ budynku","value":"kamienica"},{"@type":"PropertyValue","name":"Kuchnia","value":"z oknem"}]}}
</script>
</head><body>
<section class="detials__section description">
  <h2 class="detials__section-title">Opis oferty</h2>
  <div class="description__panel">
    <b>Lokalizacja</b><br>Klimatyczne mieszkanie na obszarze Starego Miasta przy murach obronnych średniowiecznej Warszawy, w sąsiedztwie Zamku Królewskiego, Kolumny Zygmunta, Pomnika Jana Kilińskiego, Barbakanu, licznych muzeów i zabytkowych kościołów.<br><br><b>Budynek:</b><br>Dwupiętrowa kamienica z 1953 r. z zamkniętym wewnętrznym zielonym patio dostępnym tylko dla mieszkańców. Mieszkanie na I piętrze. Dwa mieszkania na piętrze. <br><br><b>Mieszkanie</b><br>- pokój dzienny (18 m2) od strony północnej<br>- drugi pokój (18 m2) od strony południowej<br>- oddzielna kuchnia (6,5 m2) z oknem od północy<br>- łazienka (2,4 m2) z małym okienkiem od strony południowej<br>- przedpokój z wbudowaną szafą<br>Wejście do każdego z pomieszczeń z przedpokoju. Mieszkanie ciche, przestronne, odświeżone (pomalowane). Pokoje ustawne.<br>Wysokość 2,73 m.<br><br><b>Komunikacja</b><br>Dobra komunikacja - tramwaje, autobusy z bliskim dostępem do stacji metra Ratusz Arsenał.<br><br><b>Dodatkowe informacje:</b><ul><li>czynsz najmu 4500 PLN,</li></ul><ul><li>czynsz administracyjny płatny dodatkowo  1100 PLN,</li><li>dodatkowo płatny gaz i energia elektryczna,</li><li>kaucja jednomiesięczna</li><li>najem okazjonalny</li></ul>
  </div>
  <button class="description__button description__button--more">Rozwiń</button>
</section>
</body></html>`;

const CITY = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.23, lng: 21.01 };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name} ${extra}`); fail++; }
}

console.log('--- Test: domiporta.js scraper ---');

const scraper = new DomiportaScraper();
const fetched = [];
scraper._fetch = async (url, opts) => {
  fetched.push(url);
  // Real fixtures take precedence.
  if (/\/mieszkanie\/wynajme\//.test(url)) {
    if (SEARCH_HTML) return SEARCH_HTML;
    return SYNTHETIC_SEARCH_HTML;
  }
  if (/\/nieruchomosci\/wynajme-/.test(url)) {
    if (DETAIL_HTML) return DETAIL_HTML;
    return SYNTHETIC_DETAIL_HTML;
  }
  throw new Error(`test has no fixture for ${url}`);
};

// ----- TEST 1: source registration sanity -----
console.log('\n[T1] Source registration sanity');
check('scraper.sourceId === 9', scraper.sourceId === 9);
check('scraper.sourceSlug === domiporta', scraper.sourceSlug === 'domiporta');
check('scraper.baseUrl === https://www.domiporta.pl', scraper.baseUrl === 'https://www.domiporta.pl');
check('supportsStreaming === false', scraper.supportsStreaming === false);

// ----- TEST 2: externalId extraction from URL -----
console.log('\n[T2] externalId extraction');
const id1 = scraper._extractIdFromUrl('https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754');
check('id=156595754', id1 === '156595754', `(got=${id1})`);
const id2 = scraper._extractIdFromUrl('https://www.domiporta.pl/nieruchomosci/wynajme-kawalerke-warszawa-ursynow-arbuzowa-85m2/156254704');
check('id=156254704', id2 === '156254704', `(got=${id2})`);
const id3 = scraper._extractIdFromUrl('not-a-url');
check('garbage input -> null', id3 === null, `(got=${id3})`);

// ----- TEST 3: _normalizeUrl strips utm params -----
console.log('\n[T3] _normalizeUrl');
const n1 = scraper._normalizeUrl('https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-foo/123456?utm_source=bar&fbclid=abc');
check('strips utm + fbclid', n1 && !n1.includes('utm') && !n1.includes('fbclid'), `(got=${n1})`);
const n2 = scraper._normalizeUrl('https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-foo/123456');
check('clean url unchanged', n2 && n2.endsWith('/123456'), `(got=${n2})`);
const n3 = scraper._normalizeUrl(null);
check('null input handled', n3 === null, `(got=${n3})`);

// ----- TEST 4: search-card extraction (real or synthetic) -----
console.log('\n[T4] Search page card extraction');
const searchHtml = SEARCH_HTML || SYNTHETIC_SEARCH_HTML;
const cards = scraper._parseSearchCards(searchHtml, CITY);
check('search returns >0 cards', cards.length > 0, `(got ${cards.length})`);
check('search returns >=2 cards', cards.length >= 2, `(got ${cards.length})`);
const c0 = cards[0] || {};
check('card has externalId', !!c0.externalId, `(id=${c0.externalId})`);
check('card has url starting https://www.domiporta.pl', !!c0.url && c0.url.startsWith('https://www.domiporta.pl'), `(url=${c0.url})`);
check('card url contains /nieruchomosci/wynajme-', /\/nieruchomosci\/wynajme-/.test(c0.url || ''));
check('card has price', c0.price != null && c0.price > 0, `(price=${c0.price})`);
check('card has rooms', c0.rooms != null, `(rooms=${c0.rooms})`);
check('card has area', c0.area != null && c0.area > 0, `(area=${c0.area})`);
check('card has images array', Array.isArray(c0.images));
check('card has at least 1 image (search thumb)', c0.images.length >= 1, `(images=${c0.images?.length})`);
check('card sourceId=9', c0.sourceId === 9);
check('card has postedAt', !!c0.postedAt, `(postedAt=${c0.postedAt})`);
check('card has street', !!c0.street, `(street=${c0.street})`);
check('card has district', !!c0.district, `(district=${c0.district})`);
console.log(`    first card: id=${c0.externalId} price=${c0.price}PLN rooms=${c0.rooms} area=${c0.area}m2`);
console.log(`    first card url: ${c0.url}`);
console.log(`    first card cover: ${c0.images?.[0]?.slice(0, 80)}`);

// ----- TEST 5: detail-page photo extraction (REAL fixture if available, synthetic fallback) -----
console.log('\n[T5] Detail-page photo extraction');
const detailHtml = DETAIL_HTML || SYNTHETIC_DETAIL_HTML;
{
  const ad = {
    externalId: '156595754',
    price: 4500,
    images: ['https://galeria.domiporta.pl/pictures/big/placeholder.jpg'],
    raw: {},
    description: '',
    postedAt: null,
    rooms: 2, area: 48, floor: null,
    district: 'Warszawa', street: null, address: null,
    conveniences: []
  };
  scraper._applyDetail(detailHtml, ad);
  check('photos returned', Array.isArray(ad.images) && ad.images.length > 0, `(got ${ad.images?.length})`);
  check('photos count >= 5', ad.images.length >= 5, `(got ${ad.images.length})`);
  // Synthetic fixture has 8 photos; real fixture (Rycerska) also has 8.
  check('photos count >= 7 (target 8-12)', ad.images.length >= 7, `(got ${ad.images.length})`);
  check('photo url is https', ad.images.every(u => u.startsWith('https://')), `(sample=${ad.images?.[0]})`);
  check('photo url on galeria.domiporta.pl CDN', ad.images.every(u => u.includes('galeria.domiporta.pl')), `(sample=${ad.images?.[0]})`);
  check('photo url ends with .jpg', ad.images.every(u => /\.jpg$/i.test(u)), `(sample=${ad.images?.[0]})`);
  console.log(`    extracted ${ad.images.length} photos:`);
  ad.images.slice(0, 3).forEach(u => console.log(`      - ${u}`));
  if (ad.images.length > 3) console.log(`      ... +${ad.images.length - 3} more`);
}

// ----- TEST 6: detail-page description extraction -----
console.log('\n[T6] Detail-page description extraction');
{
  const ad = { externalId: '156595754', price: 4500, images: [], raw: {}, description: '', postedAt: null, rooms: 2, area: 48, floor: null, district: 'Warszawa', street: null, address: null, conveniences: [] };
  scraper._applyDetail(detailHtml, ad);
  check('description returned', !!ad.description, `(len=${ad.description?.length})`);
  check('description length >= 200', ad.description && ad.description.length >= 200, `(len=${ad.description?.length})`);
  check('description is Polish (contains mieszkanie/Lokalizacja/Budynek)',
    /mieszkanie|Lokalizacja|Budynek|zł|wynaj/i.test(ad.description || ''), `(sample=${ad.description?.slice(0,80)})`);
  check('description has newlines (multi-line)', (ad.description?.match(/\n/g) || []).length > 0, '(no newlines)');
  // Verify the full text contains content NOT in the truncated JSON-LD
  // (the JSON-LD description ends with "..."; the desc__panel has full text).
  check('description contains "Komunikacja" or "Mieszkanie" section (only in full text)',
    /Komunikacja|Mieszkanie|czynsz|kaucja/i.test(ad.description || ''), `(sample=${ad.description?.slice(0,200).replace(/\n/g, ' / ')})`);
  console.log(`    description (first 200 chars): ${(ad.description || '').slice(0, 200).replace(/\n/g, ' / ')}`);
}

// ----- TEST 7: detail-page coords extraction (MUST NOT be null per quality bar) -----
console.log('\n[T7] Detail-page coords extraction');
{
  const ad = { externalId: '156595754', price: 4500, images: [], raw: {}, description: '', postedAt: null, rooms: 2, area: 48, floor: null, district: 'Warszawa', street: null, address: null, conveniences: [] };
  scraper._applyDetail(detailHtml, ad);
  check('lat not null (quality bar)', ad.lat != null, `(lat=${ad.lat})`);
  check('lng not null (quality bar)', ad.lng != null, `(lng=${ad.lng})`);
  check('lat is plausible (49-55)', ad.lat != null && ad.lat > 49 && ad.lat < 55, `(lat=${ad.lat})`);
  check('lng is plausible (14-24)', ad.lng != null && ad.lng > 14 && ad.lng < 24, `(lng=${ad.lng})`);
  console.log(`    coords: lat=${ad.lat}, lng=${ad.lng}`);
}

// ----- TEST 8: detail-page floor / area / rooms extraction -----
console.log('\n[T8] Detail-page floor / area / rooms / address extraction');
{
  // Simulate the real flow: the search card carries rooms (from JSON-LD's
  // itemOffered.numberOfRooms), and the URL slug also encodes the room count.
  // _applyDetail should preserve the search card's rooms value (detail
  // page often omits numberOfRooms from JSON-LD).
  const ad = {
    externalId: '156595754',
    price: 4500,
    images: [],
    raw: {},
    description: '',
    postedAt: null,
    rooms: 2, // from search-card JSON-LD itemOffered.numberOfRooms
    area: 48,
    floor: null,
    district: 'Warszawa',
    street: null,
    address: null,
    conveniences: [],
    url: 'https://www.domiporta.pl/nieruchomosci/wynajme-mieszkanie-dwupokojowe-warszawa-srodmiescie-rycerska-48m2/156595754'
  };
  scraper._applyDetail(detailHtml, ad);
  check('floor present', ad.floor != null, `(floor=${ad.floor})`);
  check('area present', ad.area != null && ad.area > 0, `(area=${ad.area})`);
  check('rooms preserved/inferred', ad.rooms != null, `(rooms=${ad.rooms})`);
  check('street present', !!ad.street, `(street=${ad.street})`);
  check('district present', !!ad.district, `(district=${ad.district})`);
  check('postedAt present', !!ad.postedAt, `(postedAt=${ad.postedAt})`);
  check('price matches (4500 PLN)', ad.price === 4500, `(price=${ad.price})`);
  console.log(`    street=${ad.street}, district=${ad.district}, rooms=${ad.rooms}, area=${ad.area}m2, floor=${ad.floor}`);
}

// ----- TEST 8b: rooms-inference from title (when JSON-LD missing) -----
console.log('\n[T8b] _inferRoomsFromTitle (fallback when JSON-LD numberOfRooms is null)');
check('kawalerka → 1', scraper._inferRoomsFromTitle('Wynajmę kawalerkę w centrum') === 1);
check('dwupokojowe → 2', scraper._inferRoomsFromTitle('Mieszkanie dwupokojowe Warszawa') === 2);
check('trzypokojowe → 3', scraper._inferRoomsFromTitle('Przestronne trzypokojowe mieszkanie') === 3);
check('czteropokojowe → 4', scraper._inferRoomsFromTitle('Czteropokojowe mieszkanie z garażem') === 4);
check('5-pokojowe → 5', scraper._inferRoomsFromTitle('5-pokojowe luksusowe') === 5);
check('numeric "6 pokoi" → 6', scraper._inferRoomsFromTitle('Duże 6 pokoi w centrum') === 6);
check('garbage title → null', scraper._inferRoomsFromTitle('Apartment in Warsaw downtown') === null);

// ----- TEST 9: second fixture (Konstancińska 98 m²) — verify on a different listing -----
console.log('\n[T9] Second fixture (Mokotów Konstancińska)');
if (DETAIL2_HTML) {
  const ad = { externalId: '156759802', price: 3313, images: [], raw: {}, description: '', postedAt: null, rooms: 5, area: 98.5, floor: null, district: 'Warszawa', street: null, address: null, conveniences: [] };
  scraper._applyDetail(DETAIL2_HTML, ad);
  // Konstancińska fixture has only 5 photos — below the 8-12 target but the
  // scraper still extracts all available photos. The quality bar (>= 8) is
  // best-effort; listings with fewer photos are persisted but flagged.
  check('detail2 photos >= 5', ad.images.length >= 5, `(got ${ad.images.length})`);
  check('detail2 lat present', ad.lat != null, `(lat=${ad.lat})`);
  check('detail2 lng present', ad.lng != null, `(lng=${ad.lng})`);
  check('detail2 description present', !!ad.description, `(len=${ad.description?.length})`);
  check('detail2 street present', !!ad.street, `(street=${ad.street})`);
  check('detail2 district present', !!ad.district, `(district=${ad.district})`);
  check('detail2 floor present', ad.floor != null, `(floor=${ad.floor})`);
  console.log(`    detail2: photos=${ad.images.length}, lat=${ad.lat}, lng=${ad.lng}, street=${ad.street}, district=${ad.district}, floor=${ad.floor}`);
} else {
  console.log('    (skipped - no /tmp/domiporta-detail2.html fixture)');
}

// ----- TEST 10: end-to-end fetchCity (with mocked _fetch) -----
console.log('\n[T10] fetchCity end-to-end (mocked _fetch)');
// Force only ONE page to keep the test fast.
process.env.DOMIPORTA_MAX_PAGES = '1';
const ads = await scraper.fetchCity(CITY, { filters: {} });
process.env.DOMIPORTA_MAX_PAGES = '';
check('fetchCity returned ads', Array.isArray(ads) && ads.length > 0, `(got ${ads?.length})`);
if (ads.length) {
  const a0 = ads[0];
  check('ad has externalId', !!a0.externalId);
  check('ad has sourceId=9', a0.sourceId === 9);
  check('ad has url', !!a0.url);
  check('ad has price > 0', a0.price > 0, `(price=${a0.price})`);
  check('ad has rooms', a0.rooms != null);
  check('ad has area', a0.area != null);
  check('ad has images', Array.isArray(a0.images) && a0.images.length > 0, `(got ${a0.images?.length})`);
  check('ad images count >= 5 (enrichment ran)', a0.images.length >= 5, `(got ${a0.images.length})`);
  check('ad has description', !!a0.description && a0.description.length > 0, `(len=${a0.description?.length})`);
  check('ad has lat (quality bar)', a0.lat != null, `(lat=${a0.lat})`);
  check('ad has lng (quality bar)', a0.lng != null, `(lng=${a0.lng})`);
  check('ad lat is plausible', a0.lat > 49 && a0.lat < 55, `(lat=${a0.lat})`);
  check('ad lng is plausible', a0.lng > 14 && a0.lng < 24, `(lng=${a0.lng})`);
  check('ad has postedAt', !!a0.postedAt, `(postedAt=${a0.postedAt})`);
  check('ad has district', !!a0.district);
  check('ad has street', !!a0.street);
  check('ad currency = PLN', a0.currency === 'PLN');
  console.log(`    first ad: id=${a0.externalId} price=${a0.price}PLN rooms=${a0.rooms} area=${a0.area}m2`);
  console.log(`    photos: ${a0.images?.length}, lat=${a0.lat}, lng=${a0.lng}`);
  console.log(`    street: ${a0.street}, district: ${a0.district}`);
  console.log(`    postedAt: ${a0.postedAt}`);
  console.log(`    description (first 100 chars): ${(a0.description || '').slice(0, 100).replace(/\n/g, ' / ')}`);
}

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
process.exit(fail ? 1 : 0);
