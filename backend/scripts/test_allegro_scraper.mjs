import test from 'node:test';
import assert from 'node:assert/strict';
import { AllegroScraper } from '../src/services/scrapers/allegro.js';

// Construct a scraper instance — env vars are unset; _getToken() will throw
// when called (good: the scraper should fail loudly with an actionable
// message rather than silently fetching without auth).
const scraper = new AllegroScraper();

test('source id + slug + base url are wired up correctly', () => {
  assert.equal(scraper.sourceId, 21);
  assert.equal(scraper.sourceSlug, 'allegro');
  assert.equal(scraper.baseUrl, 'https://allegro.pl');
  assert.equal(scraper.supportsStreaming, false);
});

test('fetchCity returns [] for unconfigured cities (no city info map)', async () => {
  // Krakow / Wroclaw / Gdansk / Poznan are not in CITY_INFO — scraper no-ops.
  const krk = { id: 2, name: 'Kraków', name_pl: 'Kraków', slug: 'krakow', lat: 50.0647, lng: 19.9450 };
  const out = await scraper.fetchCity(krk);
  assert.deepEqual(out, []);
});

test('fetchCity returns [] when ALLEGRO_CLIENT_ID env is unset (no token)', async () => {
  // Save current env, ensure no Allegro creds.
  const saved = { ...process.env };
  delete process.env.ALLEGRO_CLIENT_ID;
  delete process.env.ALLEGRO_CLIENT_SECRET;
  try {
    const warsaw = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.2297, lng: 21.0122 };
    const out = await scraper.fetchCity(warsaw);
    assert.deepEqual(out, []);
  } finally {
    process.env = saved;
  }
});

test('_normalize maps a typical Allegro offer item to a normalized listing', () => {
  const city = { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.2297, lng: 21.0122 };
  // Synthesize a typical /offers/listing item.
  const ad = {
    id: '123456789',
    name: 'Mieszkanie 2 pokoje Warszawa Mokotów',
    images: [
      { url: 'https://images.allegro.pl/0/original.jpg' },
      { url: 'https://images.allegro.pl/1/original.jpg' },
      { url: 'https://images.allegro.pl/2/original.jpg' },
      { url: 'https://images.allegro.pl/3/original.jpg' },
      { url: 'https://images.allegro.pl/4/original.jpg' },
      { url: 'https://images.allegro.pl/5/original.jpg' },
      { url: 'https://images.allegro.pl/6/original.jpg' },
      { url: 'https://images.allegro.pl/7/original.jpg' },
      { url: 'https://images.allegro.pl/8/original.jpg' },
      { url: 'https://images.allegro.pl/9/original.jpg' },
      { url: 'https://images.allegro.pl/10/original.jpg' },
      { url: 'https://images.allegro.pl/11/original.jpg' },
      { url: 'https://images.allegro.pl/12/original.jpg' }
    ],
    sellingMode: {
      format: 'BUY_NOW',
      price: { amount: '3500.00', currency: 'PLN' },
      previewPrice: { amount: '3500.00', currency: 'PLN' }
    },
    parameters: [
      { id: '127662', name: 'Powierzchnia', values: ['48.5'], valuesLabel: ['48,5'], unit: 'm²' },
      { id: '127648', name: 'Liczba pokoi', values: ['2'], valuesLabel: ['2'] },
      { id: '127649', name: 'Piętro', values: ['3'], valuesLabel: ['3'] },
      { id: '127650', name: 'Liczba pięter', values: ['5'], valuesLabel: ['5'] },
      { id: '127654', name: 'Rodzaj budynku', values: ['Blok'], valuesLabel: ['Blok'] },
      { id: '127651', name: 'Dodatkowa powierzchnia', values: ['Balkon'], valuesLabel: ['Balkon'] }
    ],
    location: {
      city: { id: '110009', name: 'Warszawa' },
      region: { id: '110005', name: 'mazowieckie' },
      country: 'PL'
    },
    category: { id: '112745' },
    seller: { id: 's1', login: 'agent', company: true },
    publication: { status: 'ACTIVE', startedAt: '2026-08-29T10:00:00Z', endingAt: '2026-09-28T12:00:00Z' }
  };
  const l = scraper._normalize(ad, city);
  assert.ok(l, 'normalize returned null');
  assert.equal(l.externalId, '123456789');
  assert.equal(l.sourceId, 21);
  assert.equal(l.cityId, 1);
  assert.equal(l.title, 'Mieszkanie 2 pokoje Warszawa Mokotów');
  assert.equal(l.price, 3500);
  assert.equal(l.currency, 'PLN');
  assert.equal(l.rooms, 2);
  assert.equal(l.area, 48.5);
  assert.equal(l.floor, '3');
  assert.equal(l.district, 'Warszawa');
  assert.equal(l.url, 'https://allegro.pl/oferta/123456789');
  assert.equal(l.images.length, 12);
  assert.deepEqual(l.images.slice(0, 2), [
    'https://images.allegro.pl/0/original.jpg',
    'https://images.allegro.pl/1/original.jpg'
  ]);
  assert.equal(l.postedAt.toISOString(), '2026-08-29T10:00:00.000Z');
  // Conveniences inferred from the Balkon parameter.
  const balcony = l.conveniences.find(c => c.type === 'balcony');
  assert.ok(balcony, 'expected a balcony convenience');
});

test('_normalize rejects ads without a valid price', () => {
  const city = { id: 1, name_pl: 'Warszawa', slug: 'warsaw' };
  const noPrice = { id: '1', name: 'X', sellingMode: {} };
  assert.equal(scraper._normalize(noPrice, city), null);
  const zeroPrice = { id: '2', name: 'X', sellingMode: { price: { amount: '0', currency: 'PLN' } } };
  assert.equal(scraper._normalize(zeroPrice, city), null);
});

test('_normalizeFloor handles Polish + numeric + edge cases', () => {
  assert.equal(scraper._normalizeFloor('3'), '3');
  assert.equal(scraper._normalizeFloor('parter'), '0');
  assert.equal(scraper._normalizeFloor('Parterowy'), '0');
  assert.equal(scraper._normalizeFloor('powyżej 10'), '>10');
  assert.equal(scraper._normalizeFloor(null), null);
  assert.equal(scraper._normalizeFloor(''), null);
  assert.equal(scraper._normalizeFloor('5'), '5');
});

test('_normalizeUrl strips utm_ tracking params, keeps path', () => {
  const out = scraper._normalizeUrl('https://allegro.pl/oferta/abc-123?utm_source=email&utm_medium=newsletter&order=m');
  assert.equal(out, 'https://allegro.pl/oferta/abc-123?order=m');
  // Path-only stays path-only.
  assert.equal(scraper._normalizeUrl('https://allegro.pl/oferta/abc-123'), 'https://allegro.pl/oferta/abc-123');
});

test('_inferConveniences maps Balkon + Blok parameters', () => {
  const params = [
    { id: '127654', name: 'Rodzaj budynku', values: ['Blok'] },
    { id: '127651', name: 'Dodatkowa powierzchnia', values: ['Balkon', 'Ogródek'] }
  ];
  const conv = scraper._inferConveniences({ name: 'Metro Mokotów' }, params);
  const types = conv.map(c => c.type);
  assert.ok(types.includes('balcony'));
  assert.ok(types.includes('garden'));
  assert.ok(types.includes('building'));
  assert.ok(types.includes('transport'), 'expected Metro-in-name transport convenience');
});
