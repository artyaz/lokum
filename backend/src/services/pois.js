// POI (Points of Interest) fetching + starring for listings.
//
// Replaces the old keyword-regex approach (services/scrapers/olx.js
// #extractConveniences) that just said "Gym nearby" / "Biedronka nearby"
// when the listing description happened to mention those words — no
// distance, no coordinates, no persistence, no shared cache across
// nearby listings.
//
// This module does real geographic POI fetching:
//   1. Google Maps Places API (Nearby Search), one call per type for
//     accuracy (restaurant / store / gym / shopping_mall / park).
//   2. Results cached in the poi_cache table at a ~1m grid (5-decimal
//     lat/lng rounding) for 30 days, so all listings inside the same
//     ~1m cell share one cache row.
//   3. Falls back to the OpenStreetMap Overpass API when the Google key
//     is missing or the quota is exceeded — returns the cached payload
//     if available (even if stale), else an empty array.
//
// Starred POIs are persisted in the starred_pois table (migration
// 2026_08_pois.sql). user_id is NULLABLE so a single-user deployment
// (one person running Lokum for themselves) works without auth.

import { query, one, many } from '../db.js';

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const HTTP_TIMEOUT_MS = 9000;

// Categories we fetch. Each maps to a Google `type` and an Overpass tag
// expression — the Overpass fallback is the only path when no Google
// key is configured, and it has to return the same logical category.
export const POI_TYPES = ['restaurant', 'store', 'gym', 'shopping_mall', 'park'];

const OVERPASS_TAGS = {
  restaurant: '["amenity"~"restaurant|cafe|fast_food"]',
  store: '["shop"~"supermarket|convenience|bakery|greengrocer"]',
  gym: '["leisure"~"fitness_centre|sports_centre|pitch"]',
  shopping_mall: '["shop"="mall"]',
  park: '["leisure"~"park|garden|playground|nature_reserve"]'
};

// ---------- helpers ----------

// Round to 5 decimal places → ~1.1m at Warsaw latitude (52.2°N).
// 5 decimals is also what Google Maps' URL `@lat,lng` zoom uses for its
// short-link coord rounding, so cache cells align with what a user sees
// when they paste the listing into Google Maps.
export function round5(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e5) / 1e5;
}

// Haversine in meters — small-distance precision is fine, no need for
// the geodesicVincenty. Used for the chip's "200m / 1.2km" label and
// for the 50m starred-POI matcher fallback (when place_id is NULL).
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Human-readable distance label for the chip ("200m" / "1.2km").
export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return '';
  if (m < 1000) return Math.round(m / 10) * 10 + 'm';
  const km = m / 1000;
  return (km >= 10 ? Math.round(km) : km.toFixed(1)) + 'km';
}

// ---------- fetchers (one per type) ----------

async function fetchGoogleType(lat, lng, type, radiusMeters) {
  if (!GOOGLE_KEY) return null; // signal "no key" to the caller
  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${lat},${lng}`);
  url.searchParams.set('radius', String(radiusMeters));
  url.searchParams.set('type', type);
  url.searchParams.set('key', GOOGLE_KEY);
  // rankby=prominence (default) — gives the well-known branches first,
  // which is what the user wants to see starred across listings.
  const r = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`google_places_http_${r.status}`);
  const j = await r.json();
  if (j.status === 'OVER_QUERY_LIMIT' || j.status === 'REQUEST_DENIED') {
    throw new Error('google_quota');
  }
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(`google_status_${j.status}`);
  }
  return (j.results || []).map((p) => ({
    name: p.name || '(unnamed)',
    type,
    lat: p.geometry?.location?.lat ?? null,
    lng: p.geometry?.location?.lng ?? null,
    place_id: p.place_id || null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    address: p.vicinity || p.formatted_address || null
  }));
}

async function fetchOverpassType(lat, lng, type, radiusMeters) {
  // Cap to 30 results per type to keep payload sane (matches Google's
  // default 20-per-page prominence ranking size).
  const tags = OVERPASS_TAGS[type] || '';
  if (!tags) return [];
  const q = `[out:json][timeout:8];(node${tags}(around:${radiusMeters},${lat},${lng});way${tags}(around:${radiusMeters},${lat},${lng}););out center 30;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS + 2000)
  });
  if (!r.ok) throw new Error(`overpass_http_${r.status}`);
  const j = await r.json();
  return (j.elements || []).map((e) => {
    const elat = e.lat ?? e.center?.lat ?? null;
    const elng = e.lon ?? e.center?.lon ?? null;
    const name = e.tags?.name || e.tags?.brand || null;
    return {
      name: name || type,
      type,
      lat: elat,
      lng: elng,
      place_id: null, // OSM has no Google place_id; matched by name+coords
      rating: null,
      address: [e.tags?.['addr:street'], e.tags?.['addr:housenumber']]
        .filter(Boolean)
        .join(' ') || null
    };
  });
}

// ---------- cache layer ----------

async function getCachedType(lat, lng, type, radiusMeters) {
  const rlat = round5(lat);
  const rlng = round5(lng);
  if (rlat == null || rlng == null) return [];

  // Read-through cache: prefer fresh, fall back to stale if upstream fails.
  const cached = await one(
    `SELECT places_json, fetched_at FROM poi_cache WHERE lat = $1 AND lng = $2 AND type = $3`,
    [rlat, rlng, type]
  );
  const cachedAt = cached ? new Date(cached.fetched_at).getTime() : 0;
  const fresh = cached && Date.now() - cachedAt < CACHE_TTL_MS;
  if (fresh) {
    return typeof cached.places_json === 'string'
      ? JSON.parse(cached.places_json)
      : cached.places_json;
  }

  let places = null;
  try {
    if (GOOGLE_KEY) {
      try {
        places = await fetchGoogleType(lat, lng, type, radiusMeters);
      } catch (e) {
        if (e.message === 'google_quota') {
          // fall through to Overpass
        } else {
          throw e;
        }
      }
    }
    if (places == null) {
      // No Google key OR quota exceeded → Overpass.
      places = await fetchOverpassType(lat, lng, type, radiusMeters);
    }
  } catch (e) {
    // Upstream failed entirely — return stale cache if we have it (better
    // than blank UI) else empty. Don't rethrow; one type failing must not
    // blank the other types.
    if (cached) {
      return typeof cached.places_json === 'string'
        ? JSON.parse(cached.places_json)
        : cached.places_json;
    }
    return [];
  }

  if (!Array.isArray(places)) places = [];

  // Persist to cache. ON CONFLICT upserts so a stale row is replaced in
  // place (cheap — single index hit on the (lat,lng,type) PK).
  try {
    await query(
      `INSERT INTO poi_cache (lat, lng, type, places_json, fetched_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (lat, lng, type)
       DO UPDATE SET places_json = EXCLUDED.places_json, fetched_at = NOW()`,
      [rlat, rlng, type, JSON.stringify(places)]
    );
  } catch (e) {
    // Cache write failed (DB transient). Don't fail the request — we
    // already have the data in `places` and the next request will retry.
    console.warn('[pois] cache write failed for', type, e.message);
  }

  return places;
}

// ---------- public API ----------

/**
 * Fetch + cache all POI types for a single (lat, lng) point.
 * Returns the merged, distance-sorted, deduplicated list:
 *   [{ name, type, lat, lng, place_id, rating, address, distance_m }]
 *
 * Radius defaults to 800m (a ~10 minute walk).
 *
 * In FAKE_DB mode (LOKUM_FAKE_POIS or FAKE_DB=1 in env), short-circuits to a
 * small synthetic POI list around the given coords — so the frontend chip
 * rendering can be demoed without hitting Google/Overpass or the cache
 * layer. (No network, no DB writes — purely for local dev / storybook.)
 */
export async function getPOIs(lat, lng, radiusMeters = 800) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return [];
  }

  if (process.env.FAKE_DB === '1' || process.env.LOKUM_FAKE_POIS === '1') {
    return samplePoisAround(lat, lng);
  }

  // Parallel fetches — Google allows bursts (default quota is 60/min),
  // Overpass is happy with 5 concurrent requests. Either way each call
  // is independent of the others.
  const perType = await Promise.all(
    POI_TYPES.map((t) =>
      getCachedType(lat, lng, t, radiusMeters).catch(() => [])
    )
  );

  // Flatten + dedupe (by place_id when available, else by name+rounded coords).
  const seen = new Set();
  const out = [];
  for (const arr of perType) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (p == null || p.lat == null || p.lng == null) continue;
      const key =
        p.place_id != null
          ? `pid:${p.place_id}`
          : `nm:${String(p.name || '').toLowerCase()}|${round5(p.lat)}|${round5(p.lng)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...p,
        distance_m: haversineMeters(lat, lng, p.lat, p.lng)
      });
    }
  }
  out.sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
  return out;
}

// Synthetic POIs for FAKE_DB mode. Each entry is offset by a small delta
// around the listing coords so distances look believable (50m–1.4km).
// Names are real Warsaw POIs so the demo chips read naturally.
const FAKE_POI_DELTAS = [
  { name: 'Żabka', type: 'store', dlat: 0.0009, dlng: 0.0013, address: 'ul. Marszałkowska' },
  { name: 'Biedronka', type: 'store', dlat: -0.0016, dlng: 0.0021, address: 'ul. Świętokrzyska' },
  { name: 'McFit', type: 'gym', dlat: 0.0024, dlng: -0.0011, address: 'ul. Twarda' },
  { name: 'Złote Tarasy', type: 'shopping_mall', dlat: -0.0028, dlng: -0.0019, address: 'ul. Złota 59' },
  { name: 'Park Łazienkowski', type: 'park', dlat: 0.0061, dlng: 0.0095, address: 'Agrykola 1' },
  { name: 'Pole Mokotowskie', type: 'park', dlat: -0.0078, dlng: -0.0042, address: 'aleja Lotników' },
  { name: 'COSTA Coffee', type: 'restaurant', dlat: 0.0012, dlng: 0.0006, address: 'ul. Marszałkowska' },
  { name: 'Sushi Samuraj', type: 'restaurant', dlat: -0.0008, dlng: 0.0029, address: 'ul. Hoża' },
  { name: 'Pure Gym', type: 'gym', dlat: 0.0035, dlng: 0.0021, address: 'ul. Wilcza' },
  { name: 'Carrefour Market', type: 'store', dlat: -0.0023, dlng: 0.0011, address: 'ul. Nowy Świat' },
  { name: 'Arkadia Mall', type: 'shopping_mall', dlat: 0.0115, dlng: -0.0089, address: 'ul. Jana Pawła II 82' },
  { name: 'Laznia Park', type: 'park', dlat: 0.0042, dlng: -0.0035, address: 'ul. Ciasna' }
];

function samplePoisAround(lat, lng) {
  const out = FAKE_POI_DELTAS.map((d) => {
    const plat = lat + d.dlat;
    const plng = lng + d.dlng;
    return {
      name: d.name,
      type: d.type,
      lat: plat,
      lng: plng,
      place_id: null,
      rating: 4 + Math.random(),
      address: d.address,
      distance_m: haversineMeters(lat, lng, plat, plng)
    };
  });
  out.sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
  return out;
}

/**
 * Return the starred-POI rows for the active user (or NULL = single-user).
 * Used by the route layer to mark each fetched POI's `starred` flag.
 */
export async function getStarred(userId) {
  const rows = await many(
    `SELECT id, user_id, place_id, name, type, lat, lng, address, created_at
     FROM starred_pois
     WHERE user_id IS NOT DISTINCT FROM $1`,
    [userId || null]
  );
  return rows;
}

/**
 * Match a list of freshly-fetched POIs against a starred-POI list.
 * Match priority:
 *   1. Exact place_id (Google-sourced both sides).
 *   2. Same name (lowercased) + Haversine distance <= 50m.
 *
 * Returns a NEW array where each POI has a `starred: boolean` flag and,
 * if starred, the `starred_id` (the starred_pois.id, so the frontend can
 * DELETE by id if it wants to — but the canonical unstar call is by
 * name+type+coords+place_id, see route handler).
 */
export function matchStarred(pois, starred) {
  if (!Array.isArray(pois) || !Array.isArray(starred)) return pois || [];
  // Pre-bucket starred entries for fast lookup.
  const byPlaceId = new Map();
  const byName = []; // [{nameLower, lat, lng, row}]
  for (const s of starred) {
    if (s.place_id) byPlaceId.set(s.place_id, s);
    if (s.name) byName.push({
      nameLower: String(s.name).toLowerCase().trim(),
      lat: s.lat,
      lng: s.lng,
      row: s
    });
  }
  return pois.map((p) => {
    let match = null;
    if (p.place_id && byPlaceId.has(p.place_id)) {
      match = byPlaceId.get(p.place_id);
    }
    if (!match && p.name) {
      const nameLower = String(p.name).toLowerCase().trim();
      for (const e of byName) {
        if (e.nameLower === nameLower) {
          const d = haversineMeters(p.lat, p.lng, e.lat, e.lng);
          if (d <= 50) { match = e.row; break; }
        }
      }
    }
    return match ? { ...p, starred: true, starred_id: match.id } : { ...p, starred: false };
  });
}

/**
 * Star a POI (upsert). Body shape: { name, type, lat, lng, place_id?, address? }.
 * Returns the freshly updated starred list (so the frontend can refresh
 * all chip states in one round-trip).
 */
export async function starPOI({ name, type, lat, lng, place_id, address }, userId) {
  if (!name || !type || lat == null || lng == null) {
    throw new Error('invalid_poi_payload');
  }
  // Two unique indexes exist (idx_starred_pois_user_place and
  // idx_starred_pois_user_namecoords). To avoid a race condition where
  // a second concurrent tap inserts the same row, we ON CONFLICT upsert
  // — whichever side wins, the row is single.
  if (place_id) {
    await query(
      `INSERT INTO starred_pois (user_id, place_id, name, type, lat, lng, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, place_id) WHERE place_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type,
                    lat = EXCLUDED.lat, lng = EXCLUDED.lng, address = EXCLUDED.address`,
      [userId || null, place_id, name, type, lat, lng, address || null]
    );
  } else {
    // No place_id (Overpass-sourced). Use the (user_id, name, lat, lng)
    // unique index — but round coords to 5 decimals first so the next
    // star of the same logical POI (after a refetch nudges coords by
    // sub-meter) hits the same row.
    const rlat = round5(lat);
    const rlng = round5(lng);
    await query(
      `INSERT INTO starred_pois (user_id, place_id, name, type, lat, lng, address)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, name, lat, lng) WHERE place_id IS NULL
       DO UPDATE SET type = EXCLUDED.type, address = EXCLUDED.address`,
      [userId || null, name, type, rlat, rlng, address || null]
    );
  }
  return getStarred(userId);
}

/**
 * Unstar a POI. Body shape: { name?, type?, lat?, lng?, place_id?, starred_id? }.
 * If starred_id is provided (preferred — the row's UUID), delete by id.
 * Else fall back to (user_id, place_id) or (user_id, name, rounded lat, rounded lng).
 */
export async function unstarPOI({ place_id, name, lat, lng, starred_id }, userId) {
  if (starred_id) {
    await query(
      `DELETE FROM starred_pois WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2`,
      [starred_id, userId || null]
    );
    return getStarred(userId);
  }
  if (place_id) {
    await query(
      `DELETE FROM starred_pois WHERE place_id = $1 AND user_id IS NOT DISTINCT FROM $2`,
      [place_id, userId || null]
    );
    return getStarred(userId);
  }
  if (name && lat != null && lng != null) {
    await query(
      `DELETE FROM starred_pois
       WHERE name = $1 AND lat = $2 AND lng = $3 AND place_id IS NULL
         AND user_id IS NOT DISTINCT FROM $4`,
      [name, round5(lat), round5(lng), userId || null]
    );
    return getStarred(userId);
  }
  throw new Error('invalid_unstar_payload');
}
