// Seed sample listings so the app has data even when scrapers are blocked.
// Useful for development & demo. Idempotent — safe to run multiple times.

import 'dotenv/config';
import { pool, query, one } from './db.js';
import { persistListing } from './services/scrapers/base.js';

const SAMPLE = [
  {
    id: 'olx-waw-1', sourceSlug: 'olx', citySlug: 'warsaw',
    title: 'Bright 2-room by Łazienki Park',
    price: 3200, rooms: 2, area: 48, floor: '3/5',
    district: 'Mokotów', street: 'Puławska', lat: 52.2150, lng: 21.0200,
    images: [
      'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1505691938895-1758d7feb511?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'park', label: 'Łazienki Park · 250 m' },
      { type: 'market', label: 'Biedronka · 180 m' },
      { type: 'gym', label: 'Zdrofit · 400 m' }
    ],
    url: 'https://www.olx.pl/d/nieruchomosci/mieszkania/wynajem/warszawa/q-bright-2-room/',
    postedAgoHours: 2
  },
  {
    id: 'otodom-waw-2', sourceSlug: 'otodom', citySlug: 'warsaw',
    title: 'Modern studio in the city centre',
    price: 2800, rooms: 1, area: 32, floor: '5/8',
    district: 'Śródmieście', street: 'Marszałkowska', lat: 52.2220, lng: 21.0140,
    images: [
      'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1567767292278-a4f21aa2d36e?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'mall', label: 'Złote Tarasy · 600 m' },
      { type: 'market', label: 'Carrefour · 120 m' },
      { type: 'gym', label: 'CityFit · 350 m' }
    ],
    url: 'https://www.otodom.pl/pl/oferta/modern-studio-in-the-city-centre',
    postedAgoHours: 4
  },
  {
    id: 'olx-waw-3', sourceSlug: 'olx', citySlug: 'warsaw',
    title: 'Cozy flat steps from the Vistula',
    price: 2600, rooms: 2, area: 41, floor: '1/4',
    district: 'Praga-Południe', street: 'Wał Miedzeszyński', lat: 52.2430, lng: 21.0550,
    images: [
      'https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'park', label: 'Skaryszewski Park · 300 m' },
      { type: 'market', label: 'Lidl · 220 m' },
      { type: 'mall', label: 'Promenada · 900 m' }
    ],
    url: 'https://www.olx.pl/d/nieruchomosci/mieszkania/wynajem/warszawa/q-cozy-flat-vistula/',
    postedAgoHours: 26
  },
  {
    id: 'otodom-waw-4', sourceSlug: 'otodom', citySlug: 'warsaw',
    title: 'Spacious 3-room near Wola Park',
    price: 4500, rooms: 3, area: 68, floor: '7/10',
    district: 'Wola', street: 'Górczewska', lat: 52.2450, lng: 20.9650,
    images: [
      'https://images.unsplash.com/photo-1554995207-c18c203602cb?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'mall', label: 'Wola Park · 500 m' },
      { type: 'gym', label: 'McFit · 280 m' },
      { type: 'market', label: 'Auchan · 400 m' },
      { type: 'park', label: 'Park Sowińskiego · 650 m' }
    ],
    url: 'https://www.otodom.pl/pl/oferta/spacious-3-room-near-wola-park',
    postedAgoHours: 6
  },
  {
    id: 'olx-waw-5', sourceSlug: 'olx', citySlug: 'warsaw',
    title: 'Renovated apartment on a quiet street',
    price: 3400, rooms: 2, area: 52, floor: '2/3',
    district: 'Ochota', street: 'Grójecka', lat: 52.2190, lng: 20.9940,
    images: [
      'https://images.unsplash.com/photo-1505691938895-1758d7feb511?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'park', label: 'Pole Mokotowskie · 350 m' },
      { type: 'market', label: 'Żabka · 90 m' },
      { type: 'gym', label: 'Fabryka Formy · 500 m' }
    ],
    url: 'https://www.olx.pl/d/nieruchomosci/mieszkania/wynajem/warszawa/q-renovated/',
    postedAgoHours: 28
  },
  {
    id: 'otodom-krk-6', sourceSlug: 'otodom', citySlug: 'krakow',
    title: 'Loft in the heart of Kazimierz',
    price: 3800, rooms: 2, area: 55, floor: '3/3',
    district: 'Kazimierz', street: 'Szeroka', lat: 50.0510, lng: 19.9450,
    images: [
      'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'park', label: 'Planty Park · 200 m' },
      { type: 'market', label: 'Kaufland · 300 m' },
      { type: 'gym', label: 'Just Gym · 450 m' }
    ],
    url: 'https://www.otodom.pl/pl/oferta/loft-in-the-heart-of-kazimierz',
    postedAgoHours: 3
  },
  {
    id: 'olx-krk-7', sourceSlug: 'olx', citySlug: 'krakow',
    title: 'Sunny studio near the Main Square',
    price: 3000, rooms: 1, area: 34, floor: '4/5',
    district: 'Stare Miasto', street: 'Floriańska', lat: 50.0647, lng: 19.9410,
    images: [
      'https://images.unsplash.com/photo-1567767292278-a4f21aa2d36e?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'mall', label: 'Galeria Krakowska · 400 m' },
      { type: 'market', label: 'Biedronka · 150 m' },
      { type: 'park', label: 'Planty · 250 m' }
    ],
    url: 'https://www.olx.pl/d/nieruchomosci/mieszkania/wynajem/krakow/q-sunny-studio/',
    postedAgoHours: 5
  },
  {
    id: 'otodom-krk-8', sourceSlug: 'otodom', citySlug: 'krakow',
    title: 'Family flat with garden view',
    price: 4200, rooms: 3, area: 72, floor: '6/9',
    district: 'Podgórze', street: 'Limanowskiego', lat: 50.0410, lng: 19.9610,
    images: [
      'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1554995207-c18c203602cb?w=800&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80&auto=format&fit=crop'
    ],
    conv: [
      { type: 'park', label: 'Bednarski Park · 300 m' },
      { type: 'mall', label: 'Bonarka · 1.2 km' },
      { type: 'market', label: 'Lidl · 200 m' },
      { type: 'gym', label: 'Xtreme Fitness · 550 m' }
    ],
    url: 'https://www.otodom.pl/pl/oferta/family-flat-with-garden-view',
    postedAgoHours: 48
  }
];

async function seed() {
  // Idempotent: clear out seeded data so re-runs produce a consistent state.
  // We keep users + cities + sources (they're upserted).
  console.log('[seed] resetting data tables...');
  await query(`DELETE FROM cron_run_listings`);
  await query(`DELETE FROM cron_runs`);
  await query(`DELETE FROM listing_conveniences`);
  await query(`DELETE FROM listing_images`);
  await query(`DELETE FROM saved_listings`);
  await query(`DELETE FROM listings`);
  // NB: we deliberately do NOT DELETE cron_jobs — those are user-defined
  // and we want them to survive a re-seed. The default job (below) is
  // upserted, not blown away + recreated, so a user who customized the
  // schedule keeps their version.

  // Make sure demo user exists
  const demoEmail = 'anna@lokum.pl';
  let user = await one(`SELECT id FROM users WHERE email = $1`, [demoEmail]);
  if (!user) {
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash('password', 10);
    user = await one(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
       RETURNING id`,
      [demoEmail, 'Anna Kowalska', hash]
    );
    console.log('[seed] created demo user', demoEmail, 'with password "password"');
  }

  // Resolve source/city ids
  const sources = await query(`SELECT id, slug FROM sources`);
  const cities = await query(`SELECT id, slug FROM cities`);

  // Build a "yesterday's cron run" — these listings are NOT new today.
  // Use NOW()-24h so it's older than todayRun (NOW()-4h).
  const yesterdayRun = await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by)
     VALUES (NOW() - INTERVAL '28 hours', NOW() - INTERVAL '28 hours' + INTERVAL '2 seconds',
             'success', 5, 5, 2100, 'cron')
     RETURNING id, started_at`
  );

  // Build a "today's morning cron run" — these are the NEW today ones.
  const todayRun = await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by)
     VALUES (NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours' + INTERVAL '1400 milliseconds',
             'success', 5, 5, 1400, 'cron')
     RETURNING id, started_at`
  );

  let newTodayCount = 0;
  let olderCount = 0;

  for (const s of SAMPLE) {
    const source = sources.rows.find(x => x.slug === s.sourceSlug);
    const city = cities.rows.find(x => x.slug === s.citySlug);
    if (!source || !city) continue;

    const postedAt = new Date(Date.now() - (s.postedAgoHours || 0) * 3600_000);
    // For the older ones, set first_seen_at to yesterdayRun.started_at so they look "old"
    // (i.e., they were first seen in yesterday's run, not today's).
    const isNewToday = (s.postedAgoHours || 0) < 24;
    // Use the actual cron_run.started_at timestamps so the listings align exactly
    // with the run that "discovered" them.
    const firstSeenAt = isNewToday
      ? new Date(todayRun.started_at)
      : new Date(yesterdayRun.started_at);

    const listing = {
      externalId: s.id,
      sourceId: source.id,
      cityId: city.id,
      title: s.title,
      price: s.price,
      currency: 'PLN',
      rooms: s.rooms,
      area: s.area,
      floor: s.floor,
      district: s.district,
      street: s.street,
      address: `${s.district}, ${s.citySlug}`,
      lat: s.lat,
      lng: s.lng,
      url: s.url,
      postedAt,
      images: s.images,
      conveniences: s.conv,
      raw: { seeded: true }
    };

    // Insert with explicit first_seen_at
    const existing = await one(
      `SELECT id FROM listings WHERE source_id = $1 AND external_id = $2`,
      [source.id, s.id]
    );
    let listingId;
    if (existing) {
      // Update existing — also reset first_seen_at to keep the run alignment consistent
      await query(
        `UPDATE listings SET
           title=$1, price=$2, rooms=$3, area=$4, floor=$5, district=$6, street=$7,
           address=$8, lat=$9, lng=$10, url=$11, posted_at=$12,
           first_seen_at=$13,
           last_seen_at=NOW(), is_active=TRUE
         WHERE id=$14`,
        [listing.title, listing.price, listing.rooms, listing.area,
         listing.floor, listing.district, listing.street, listing.address,
         listing.lat, listing.lng, listing.url, listing.postedAt,
         firstSeenAt, existing.id]
      );
      listingId = existing.id;
      console.log('[seed] updated', s.id, 'isNewToday=', isNewToday);
    } else {
      const r = await one(
        `INSERT INTO listings
           (source_id, external_id, city_id, title, price, currency, rooms, area, floor,
            district, street, address, lat, lng, url, posted_at, first_seen_at, last_seen_at, is_active, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), TRUE, $18::jsonb)
         RETURNING id`,
        [source.id, listing.externalId, city.id, listing.title, listing.price, 'PLN',
         listing.rooms, listing.area, listing.floor, listing.district, listing.street,
         listing.address, listing.lat, listing.lng, listing.url, listing.postedAt,
         firstSeenAt, JSON.stringify({ seeded: true })]
      );
      listingId = r.id;
      console.log('[seed] inserted', s.id, 'isNewToday=', isNewToday);
    }

    // Images
    await query(`DELETE FROM listing_images WHERE listing_id = $1`, [listingId]);
    // Task A3: batched multi-row INSERT (same unnest pattern A2 used in
    // base.js#persistListing). 8 sample listings × ~3 photos each = ~24
    // INSERTs saved → 8. A dev-script micro-optimization, but keeps the
    // pattern consistent across the codebase.
    if (listing.images?.length) {
      const imgs = listing.images;
      const urls = imgs.map(String);
      const positions = imgs.map((_, i) => i);
      await query(
        `INSERT INTO listing_images (listing_id, url, position)
         SELECT $1, url, pos FROM unnest($2::text[], $3::int[]) AS t(url, pos)`,
        [listingId, urls, positions]
      );
    }

    // Conveniences
    await query(`DELETE FROM listing_conveniences WHERE listing_id = $1`, [listingId]);
    // Task A3: same batched-INSERT pattern as images above.
    if (listing.conveniences?.length) {
      const convs = listing.conveniences;
      const types = convs.map(c => String(c.type));
      const labels = convs.map(c => String(c.label));
      await query(
        `INSERT INTO listing_conveniences (listing_id, type, label)
         SELECT $1, t.type, t.label
           FROM unnest($2::text[], $3::text[]) AS t(type, label)
         ON CONFLICT DO NOTHING`,
        [listingId, types, labels]
      );
    }

    // Link to appropriate cron run
    if (isNewToday) {
      await query(
        `INSERT INTO cron_run_listings (cron_run_id, listing_id, was_new)
         VALUES ($1, $2, TRUE)
         ON CONFLICT DO NOTHING`,
        [todayRun.id, listingId]
      );
      newTodayCount++;
    } else {
      await query(
        `INSERT INTO cron_run_listings (cron_run_id, listing_id, was_new)
         VALUES ($1, $2, TRUE)
         ON CONFLICT DO NOTHING`,
        [yesterdayRun.id, listingId]
      );
      olderCount++;
    }
  }

  // Seed a couple extra historical runs for the dropdown
  await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by)
     VALUES (NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours' + INTERVAL '1100 milliseconds',
             'success', 12, 12, 1100, 'cron') RETURNING id`
  );
  await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by)
     VALUES (NOW() - INTERVAL '54 hours', NOW() - INTERVAL '54 hours' + INTERVAL '1600 milliseconds',
             'success', 41, 41, 1600, 'cron') RETURNING id`
  );
  await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by, error)
     VALUES (NOW() - INTERVAL '78 hours', NOW() - INTERVAL '78 hours' + INTERVAL '4200 milliseconds',
             'partial', 9, 9, 4200, 'cron', 'OLX slow response') RETURNING id`
  );
  await one(
    `INSERT INTO cron_runs (started_at, finished_at, status, new_count, total_count, duration_ms, triggered_by)
     VALUES (NOW() - INTERVAL '102 hours', NOW() - INTERVAL '102 hours' + INTERVAL '950 milliseconds',
             'success', 33, 33, 950, 'cron') RETURNING id`
  );

  console.log(`[seed] done — ${newTodayCount} new today, ${olderCount} older`);

  // Seed a default cron_jobs row for the demo user — without this, the
  // scheduler (services/cron.js initScheduler) has nothing to fire and no
  // listings ever appear, which is the most likely operational cause of the
  // "haven't seen olx in a long time" complaint.
  //
  // The job runs every 4 hours, all 5 supported cities × all 5 sources,
  // no filters. We only INSERT if no row exists for this user — we never
  // overwrite a row the user has created themselves.
  //
  // Sources: 1=olx, 2=otodom, 3=adresowo, 4=gratka, 5=morizon, 7=facebook,
  //         8=nieruchomosci-online (Task D1), 9=domiporta (Task D2),
  //         10=oferty-net (Task D3), 11=gethome (Task D4),
  //         12=tabelaofert (Task D5),
  //         14=bezposrednio (Task D-bezposrednio-7),
  //         15=okolica (Task D10), 16=sprzedajemy (Task D-sprzedajemy-8),
  //         17=wynajem24 (Task D-wynajem24-11), 18=lento (Task D-lento-9),
  //         19=rentola (Task D-rentola-12), 20=telegram (Task D-telegram-13),
  //         13=odwlasciciela (Task D-odwlasciciela-6), 21=allegro (Task D-allegro-14).
  // Cities:  1=warsaw, 2=krakow, 3=wroclaw, 4=gdansk, 5=poznan.
  const existingJob = await one(
    `SELECT id FROM cron_jobs WHERE user_id = $1`,
    [user.id]
  );
  if (existingJob) {
    console.log('[seed] user already has a cron_jobs row — leaving it untouched');
  } else {
    const defaultJob = await one(
      `INSERT INTO cron_jobs (user_id, name, schedule, source_ids, city_ids, filters, enabled)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE)
       RETURNING id`,
      [
        user.id,
        'default-fetch-all',
        '0 */4 * * *',                                    // every 4 hours
        [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],     // all sources
        [1, 2, 3, 4, 5],                                 // all cities
        JSON.stringify({})                                // no filters
      ]
    );
    console.log('[seed] created default cron job:', defaultJob.id, '(every 4h, all sources × all cities)');
  }

  await pool.end();
}

seed().catch(e => {
  console.error('[seed] FAILED:', e);
  process.exit(1);
});
