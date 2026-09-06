// Sample dataset for the fake DB (FAKE_DB=1).
// Deterministic PRNG so the data is stable across restarts.

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260810);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const chance = (p) => rnd() < p;

const CITIES = [
  { id: 1, name: 'Warsaw', name_pl: 'Warszawa', slug: 'warsaw', lat: 52.2297, lng: 21.0122 },
  { id: 2, name: 'Kraków', name_pl: 'Kraków', slug: 'krakow', lat: 50.0647, lng: 19.945 },
  { id: 3, name: 'Wrocław', name_pl: 'Wrocław', slug: 'wroclaw', lat: 51.1079, lng: 17.0385 },
  { id: 4, name: 'Gdańsk', name_pl: 'Gdańsk', slug: 'gdansk', lat: 54.352, lng: 18.6466 },
  { id: 5, name: 'Poznań', name_pl: 'Poznań', slug: 'poznan', lat: 52.4064, lng: 16.9252 }
];

const SOURCES = [
  { id: 1, name: 'OLX', slug: 'olx', color: '#0A6E68', base_url: 'https://www.olx.pl' },
  { id: 2, name: 'Otodom', slug: 'otodom', color: '#A4133C', base_url: 'https://www.otodom.pl' },
  { id: 3, name: 'Adresowo', slug: 'adresowo', color: '#3E82A8', base_url: 'https://adresowo.pl' },
  { id: 4, name: 'Gratka', slug: 'gratka', color: '#7B5EA7', base_url: 'https://gratka.pl' },
  { id: 5, name: 'Morizon', slug: 'morizon', color: '#B08968', base_url: 'https://www.morizon.pl' },
  { id: 6, name: 'Community', slug: 'community', color: '#5B574E', base_url: 'https://flats.chmyl.com' },
  { id: 8, name: 'Nieruchomosci-online', slug: 'nieruchomosci-online', color: '#2D7A3E', base_url: 'https://www.nieruchomosci-online.pl' },
  { id: 10, name: 'Oferty.net', slug: 'oferty-net', color: '#5C6BC0', base_url: 'https://www.oferty.net' },
  { id: 11, name: 'Gethome', slug: 'gethome', color: '#9069c0', base_url: 'https://gethome.pl' },
  { id: 12, name: 'Tabelaofert', slug: 'tabelaofert', color: '#1A8A6E', base_url: 'https://tabelaofert.pl' }
];

const DISTRICTS = {
  1: ['Mokotów', 'Śródmieście', 'Wola', 'Ochota', 'Żoliborz', 'Praga-Południe', 'Praga-Północ', 'Ursynów', 'Bielany', 'Bemowo', 'Targówek', 'Wilanów', 'Ursus', 'Włochy', 'Białołęka'],
  2: ['Kazimierz', 'Podgórze', 'Krowodrza', 'Grzegórzki', 'Prądnik Biały', 'Bronowice', 'Dębniki', 'Łagiewniki']
};

const STREETS = {
  1: ['Marszałkowska', 'Puławska', 'Grójecka', 'Jana Pawła II', 'Andersa', 'Krucza', 'Hoża', 'Wilcza', 'Koszykowa', 'Złota', 'Prosta', 'Kasprzaka', 'Wolska', 'Górczewska', 'Kasprowicza', 'Światowida', 'Modlińska', 'Fieldorfa', 'Targowa', 'Zamoyskiego', 'Solec', 'Czerniakowska', 'Sobieskiego', 'Aleja Wilanowska', 'Rzymowskiego'],
  2: ['Grodzka', 'Floriańska', 'Długa', 'Karmelicka', 'Królewska', 'Wielicka', 'Kalwaryjska', 'Limanowskiego', 'Dietla', 'Starowiślna']
};

const TITLE_TPL = [
  (r, d, s) => `Cozy ${r.rooms}-room flat near the metro · ${d}`,
  (r, d, s) => `Bright ${r.area} m² apartment in ${d}`,
  (r, d, s) => `${r.rooms} rooms with balcony · ${s} street`,
  (r, d, s) => `Renovated tenement flat · ${d}`,
  (r, d, s) => `Modern studio, heart of ${d}`,
  (r, d, s) => `${r.rooms}-room flat, quiet street in ${d}`,
  (r, d, s) => `Sunny ${r.area} m² near the park · ${d}`,
  (r, d, s) => `High-standard ${r.rooms} rooms · ${d}`,
  (r, d, s) => `${d}, ${r.rooms} rooms, available immediately`,
  (r, d, s) => `Comfortable flat with terrace · ${s}`
];

const DESC_PARTS = [
  'Do wynajęcia przytulne, w pełni umeblowane mieszkanie w świetnej lokalizacji. Okolica spokojna, zielona, z pełną infrastrukturą miejską.',
  'Mieszkanie składa się z przestronnego salonu z aneksem kuchennym, wygodnej sypialni oraz łazienki z prysznicem. Okna wychodzą na ciche podwórko.',
  'W pobliżu znajdują się przystanki tramwajowe i autobusowe, sklepy, kawiarnie oraz tereny rekreacyjne. Doskonały dojazd do centrum.',
  'Kuchnia wyposażona w lodówkę, zmywarkę, płytę indukcyjną i piekarnik. W łazience pralka. W przedpokoju pojemna szafa.',
  'Budynek z windą, monitorowany, z zadbaną klatką schodową. Do mieszkania przynależy balkon oraz miejsce postojowe w garażu podziemnym (dodatkowo płatne).',
  'Kaucja jednomiesięczna. Najem okazjonalny. Mieszkanie dostępne od zaraz, idealne dla pary lub singla. Zwierzęta do uzgodnienia.',
  'Media płatne dodatkowo według zużycia. Internet światłowodowy w cenie. Ogrzewanie miejskie, okna plastikowe.',
  'Świetna propozycja dla osób ceniących sobie komfort i bliskość centrum. Zapraszam na prezentację!'
];

const CONV_POOL = [
  { type: 'park', labels: ['Park · 250 m', 'City park · 400 m', 'Riverside paths · 300 m'] },
  { type: 'transport', labels: ['Metro · 200 m', 'Tram stop · 150 m', 'Bus stop · 100 m', 'Rail station · 600 m'] },
  { type: 'mall', labels: ['Shopping mall · 500 m', 'Grocery · 120 m'] },
  { type: 'gym', labels: ['Gym · 300 m', 'Fitness club · 450 m'] },
  { type: 'market', labels: ['Local market · 350 m'] },
  { type: 'school', labels: ['University · 800 m'] }
];

function makeDescription() {
  const n = int(3, 5);
  const parts = [];
  const used = new Set();
  while (parts.length < n) {
    const i = int(0, DESC_PARTS.length - 1);
    if (used.has(i)) continue;
    used.add(i);
    parts.push(DESC_PARTS[i]);
  }
  return parts.join('\n\n');
}

function makeParams(l) {
  return [
    { name: 'Powierzchnia', value: `${l.area} m²` },
    { name: 'Liczba pokoi', value: String(l.rooms) },
    { name: 'Piętro', value: l.floor },
    { name: 'Rodzaj zabudowy', value: pick(['blok', 'kamienica', 'apartamentowiec']) },
    { name: 'Ogrzewanie', value: 'miejskie' },
    { name: 'Dostępne od', value: 'zaraz' },
    { name: 'Kaucja', value: `${l.price} zł` }
  ];
}

function makeParamsEn(l) {
  return [
    { label: 'Area', value: `${l.area} m²` },
    { label: 'Rooms', value: String(l.rooms) },
    { label: 'Floor', value: l.floor },
    { label: 'Building', value: pick(['block', 'tenement', 'apartment building']) },
    { label: 'Heating', value: 'district heating' },
    { label: 'Available', value: 'immediately' },
    { label: 'Deposit', value: `${l.price} PLN` }
  ];
}

export function buildSeed() {
  const now = Date.now();
  const H = 3600_000;

  // ---- cron runs: 8 runs over the last ~4 days, newest first ----
  const runOffsetsH = [2, 14, 26, 38, 50, 62, 74, 86];
  // Task G: cron_job_id is filled below after the demo cron_job row is
  // created — the newest run gets linked so the Crons UI shows "last run
  // for THIS job" in the demo. Older runs stay unlinked (NULL), which is
  // realistic — pre-Task-G history has no cron_job_id.
  const cron_runs = runOffsetsH.map((off, i) => ({
    id: randomUUID(),
    started_at: new Date(now - off * H),
    finished_at: new Date(now - off * H + int(40, 160) * 1000),
    status: i === 3 ? 'partial' : 'success',
    source_id: null,
    city_id: null,
    cron_job_id: null, // patched below for index 0
    new_count: 0, // filled below
    total_count: 0,
    duration_ms: int(40_000, 160_000),
    error: i === 3 ? 'otodom: 3 pages failed to parse' : null,
    triggered_by: i % 3 === 2 ? 'manual' : 'cron',
    filters: {}
  }));

  // ---- listings ----
  const listings = [];
  const listing_images = [];
  const listing_conveniences = [];
  const cron_run_listings = [];

  // how many NEW listings each run introduced (index 0 = latest run)
  const newPerRun = [60, 16, 19, 12, 24, 15, 20, 42];

  let imgSeed = 1;
  function addImages(listingId, count) {
    for (let i = 0; i < count; i++) {
      listing_images.push({
        id: randomUUID(),
        listing_id: listingId,
        url: `https://picsum.photos/seed/lokum${imgSeed++}/900/675`,
        position: i
      });
    }
  }

  function addConveniences(listingId) {
    if (!chance(0.7)) return;
    const n = int(1, 3);
    const used = new Set();
    for (let i = 0; i < n; i++) {
      const c = pick(CONV_POOL);
      if (used.has(c.type)) continue;
      used.add(c.type);
      listing_conveniences.push({
        id: randomUUID(),
        listing_id: listingId,
        type: c.type,
        label: pick(c.labels)
      });
    }
  }

  function makeListing(cityId, runIdx) {
    const city = CITIES.find(c => c.id === cityId);
    const district = pick(DISTRICTS[cityId] || DISTRICTS[1]);
    const street = pick(STREETS[cityId] || STREETS[1]);
    const rooms = chance(0.15) ? 1 : int(2, 4);
    const area = rooms === 1 ? int(22, 34) : int(30 + rooms * 8, 40 + rooms * 14);
    const price = Math.round((1400 + area * int(42, 68) + rnd() * 500) / 50) * 50;
    const floor = chance(0.3) ? `${int(1, 6)}` : `${int(1, 7)}/${int(3, 10)}`;
    // keep ~18 listings inside a central-Warsaw box so the seeded region matches
    const central = cityId === 1 && listings.filter(l => l.city_id === 1 && l._central).length < 18 && chance(0.25);
    const lat = cityId === 1 && central
      ? 52.223 + rnd() * 0.014
      : city.lat + (rnd() - 0.5) * 0.12;
    const lng = cityId === 1 && central
      ? 21.004 + rnd() * 0.02
      : city.lng + (rnd() - 0.5) * 0.16;
    const source = pick(SOURCES.slice(0, 5));
    const run = cron_runs[runIdx];
    const firstSeen = new Date(run.started_at.getTime() + int(1, 50) * 1000);

    const l = {
      id: randomUUID(),
      source_id: source.id,
      external_id: `${source.slug}-${imgSeed}-${int(1000, 9999)}`,
      city_id: cityId,
      title: pick(TITLE_TPL)({ rooms, area }, district, street),
      description: makeDescription(),
      description_en: null,
      params_en: null,
      price,
      currency: 'PLN',
      rooms,
      area,
      floor,
      district,
      street,
      address: `${street} ${int(1, 120)}, ${city.name_pl}`,
      lat,
      lng,
      url: `${source.base_url}/oferta/${source.slug}-${imgSeed}`,
      posted_at: new Date(firstSeen.getTime() - int(0, 10) * H),
      first_seen_at: firstSeen,
      last_seen_at: new Date(now - int(0, 3) * H),
      is_active: true,
      raw: { params: [] },
      total_estimate: null,
      total_breakdown: null,
      _central: central
    };
    l.raw.params = makeParams(l);

    // AI extras on a subset
    if (chance(0.45)) {
      const admin = int(300, 700);
      const utils = int(150, 350);
      l.total_estimate = price + admin + utils;
      l.total_breakdown = {
        items: [
          { label: 'Administrative fee', amount_pln: admin, estimated: false },
          { label: 'Utilities', amount_pln: utils, estimated: true }
        ],
        notes: 'Electricity billed separately by meter.',
        computed_at: new Date(firstSeen.getTime() + 600_000).toISOString()
      };
    }
    if (chance(0.3)) {
      l.description_en = `## About the apartment\n\nA **${rooms}-room** flat of **${area} m²** in ${district}, available immediately.\n\n- Fully furnished with equipped kitchen\n- ${floor.includes('/') ? `Floor ${floor}` : `Floor ${floor}`}\n- Quiet neighbourhood with good transport links\n\n## Costs\n\nRent **${price} PLN/month** plus administrative fees. Deposit: one month's rent.`;
      l.params_en = makeParamsEn(l);
    }

    listings.push(l);
    addImages(l.id, int(3, 6));
    addConveniences(l.id);

    // cron_run_listings: new in its own run, re-seen in all later runs
    for (let r = runIdx; r >= 0; r--) {
      cron_run_listings.push({
        cron_run_id: cron_runs[r].id,
        listing_id: l.id,
        was_new: r === runIdx,
        seen_at: cron_runs[r].started_at
      });
    }
    return l;
  }

  for (let runIdx = cron_runs.length - 1; runIdx >= 0; runIdx--) {
    const count = newPerRun[runIdx];
    for (let i = 0; i < count; i++) {
      // mostly Warsaw, some Kraków
      makeListing(chance(0.8) ? 1 : 2, runIdx);
    }
  }

  // deactivate a handful (they still show under historical runs)
  for (let i = 0; i < 9; i++) {
    const l = pick(listings);
    l.is_active = false;
    l.last_seen_at = new Date(l.first_seen_at.getTime() + 20 * H);
    // drop from runs after it disappeared
    const goneAfter = cron_runs.filter(r => r.started_at > new Date(l.last_seen_at.getTime()));
    for (const r of goneAfter) {
      const idx = cron_run_listings.findIndex(c => c.cron_run_id === r.id && c.listing_id === l.id);
      if (idx >= 0) cron_run_listings.splice(idx, 1);
    }
  }

  // run counters
  for (const run of cron_runs) {
    const entries = cron_run_listings.filter(c => c.cron_run_id === run.id);
    run.new_count = entries.filter(c => c.was_new).length;
    run.total_count = entries.length;
  }

  // ---- one flat, five portals: same photos, conflicting metadata ----
  // Exactly the real-world case that breaks geo-gated dedupe: missing or
  // wrong coordinates, different street spellings, misreported rooms/area.
  // Detected at boot by the real dedupe pipeline (photo-first matching);
  // the feed then shows only the preferred source (OLX).
  const dupImages = [1, 2, 3, 4].map(i => `https://picsum.photos/seed/dupflat${i}/900/675`);
  const dupSpecs = [
    { src: 1, street: 'Marszałkowska', address: 'Marszałkowska 12, Warszawa', lat: 52.2251, lng: 21.0061, rooms: 2, area: 48, price: 4500, title: '2-room flat near the centre' },
    { src: 2, street: 'ul. Marszałkowska 12', address: null, lat: null, lng: null, rooms: 2, area: 47.5, price: 4600, title: 'Przestronne 2 pokoje, Śródmieście' },
    { src: 3, street: null, address: 'Marszałkowska 12', lat: 52.231, lng: 21.014, rooms: 3, area: 48, price: 4450, title: 'Mieszkanie 2-pokojowe do wynajęcia' },
    { src: 4, street: null, address: 'Śródmieście, Warszawa', lat: null, lng: null, rooms: null, area: null, price: 4700, title: 'Wynajem 2 pokoje centrum' },
    { src: 5, street: 'ul. Marszałkowska 12/4', address: null, lat: 52.29, lng: 21.09, rooms: 2, area: 52, price: 4500, title: '2 rooms, great location' }
  ];
  for (const d of dupSpecs) {
    const id = randomUUID();
    const firstSeen = new Date(cron_runs[0].started_at.getTime() + int(1, 40) * 1000);
    listings.push({
      id,
      source_id: d.src,
      external_id: `dup-${d.src}`,
      city_id: 1,
      title: d.title,
      description: 'To samo mieszkanie ogłoszone na kilku portalach — identyczne zdjęcia, rozbieżne dane.',
      description_en: null,
      params_en: null,
      price: d.price,
      currency: 'PLN',
      rooms: d.rooms,
      area: d.area,
      floor: '3',
      district: 'Śródmieście',
      street: d.street,
      address: d.address,
      lat: d.lat,
      lng: d.lng,
      url: `${SOURCES[d.src - 1].base_url}/oferta/dup-${d.src}`,
      posted_at: firstSeen,
      first_seen_at: firstSeen,
      last_seen_at: new Date(now - H),
      is_active: true,
      raw: { params: [] },
      total_estimate: null,
      total_breakdown: null
    });
    dupImages.forEach((url, i) => listing_images.push({ id: randomUUID(), listing_id: id, url, position: i }));
    cron_run_listings.push({ cron_run_id: cron_runs[0].id, listing_id: id, was_new: true, seen_at: cron_runs[0].started_at });
  }
  const listing_duplicates = []; // filled by the real dedupe scan at boot

  // ---- demo user ----
  const demoUser = {
    id: randomUUID(),
    email: 'demo@lokum.dev',
    name: 'Demo',
    password_hash: bcrypt.hashSync('demo1234', 10),
    created_at: new Date(now - 30 * 24 * H)
  };

  // saved listings (3 most recent active Warsaw ones)
  const savedCandidates = listings
    .filter(l => l.is_active && l.city_id === 1)
    .sort((a, b) => b.first_seen_at - a.first_seen_at)
    .slice(0, 3);
  const saved_listings = savedCandidates.map((l, i) => ({
    user_id: demoUser.id,
    listing_id: l.id,
    created_at: new Date(now - (i + 1) * 5 * H)
  }));

  // ---- a drawn region over central Warsaw ----
  const regions = [{
    id: randomUUID(),
    user_id: demoUser.id,
    city_id: 1,
    name: 'Central Warsaw',
    color: '#C15F3C',
    polygon: {
      type: 'Polygon',
      coordinates: [[
        [21.0, 52.22], [21.03, 52.22], [21.03, 52.24], [21.0, 52.24], [21.0, 52.22]
      ]]
    },
    created_at: new Date(now - 12 * 24 * H)
  }];

  // ---- share token for the newest listing ----
  const newest = [...listings].sort((a, b) => b.first_seen_at - a.first_seen_at)[0];
  const share_tokens = [{
    token: 'demo0share0token',
    listing_id: newest.id,
    user_id: demoUser.id,
    created_at: new Date(now - 2 * H)
  }];

  // ---- telegram + settings ----
  const telegram_settings = [{
    user_id: demoUser.id,
    chat_id: null,
    enabled: false,
    min_price: null,
    max_price: 7000,
    region_ids: [],
    created_at: new Date(now - 10 * 24 * H),
    updated_at: new Date(now - 10 * 24 * H)
  }];

  const cron_jobs = [{
    id: randomUUID(),
    user_id: demoUser.id,
    name: 'Morning & evening fetch',
    schedule: '0 7,18 * * *',
    source_ids: [1, 2],
    city_ids: [1],
    filters: { maxPrice: 8000 },
    enabled: true,
    last_run_at: cron_runs[0].started_at,
    next_run_at: new Date(now + 6 * H),
    created_at: new Date(now - 20 * 24 * H)
  }];

  // Task G — link the newest two cron_runs back to the demo cron_job so
  // the Crons UI's "last run for THIS job" panel shows realistic data
  // in FAKE_DB mode. Older runs stay unlinked (pre-Task-G history).
  cron_runs[0].cron_job_id = cron_jobs[0].id;
  cron_runs[1].cron_job_id = cron_jobs[0].id;

  const tables = {
    users: [demoUser],
    passkeys: [],
    sessions: [],
    cities: CITIES.map(c => ({ ...c })),
    sources: SOURCES.map(s => ({ ...s })),
    listings: listings.map(({ _central, ...l }) => l),
    listing_images,
    listing_conveniences,
    cron_runs,
    cron_run_listings,
    cron_jobs,
    saved_listings,
    regions,
    share_tokens,
    app_settings: [],
    telegram_settings,
    telegram_sent: [],
    listing_duplicates,
    // Task F: POI cache + starred-POI persistence (empty in fake seed;
    // getPOIs short-circuits to sample data when FAKE_DB=1).
    poi_cache: [],
    starred_pois: []
  };

  return { tables };
}
