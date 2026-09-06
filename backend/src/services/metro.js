// Warsaw metro stations + nearest-station lookup.
//
// Station coordinates were pulled from OpenStreetMap (railway=station +
// station=subway inside Warszawa admin boundary, 2026-09-06) and are stored
// here as a static dataset so the lookup is a local haversine computation —
// no API key, no network, no per-listing cost. OSM has 38 unique stations:
// M1 (21, Kabaty <-> Młociny) and M2 (18, Bemowo <-> Bródno) share the
// Świętokrzyska interchange, hence 21 + 18 - 1 = 38.
//
// Stored on listings.nearest_metro JSONB as {name, line, distance_m} by
// backfillMetro(), which the fetch cycle runs after enrichment. The feed
// exposes it as `nearestMetro` for the metro chip on every card.

import { query, many } from '../db.js';

// [name, line, lat, lng] — M1 south -> north, then M2 west -> east.
const STATIONS = [
  // --- M1 ---
  ['Kabaty', 'M1', 52.132076, 21.065071],
  ['Natolin', 'M1', 52.141101, 21.056435],
  ['Imielin', 'M1', 52.1493, 21.046106],
  ['Stokłosy', 'M1', 52.156076, 21.034723],
  ['Ursynów', 'M1', 52.162046, 21.027628],
  ['Służew', 'M1', 52.172762, 21.026287],
  ['Wilanowska', 'M1', 52.181817, 21.023145],
  ['Wierzbno', 'M1', 52.189872, 21.016797],
  ['Racławicka', 'M1', 52.198864, 21.012235],
  ['Pole Mokotowskie', 'M1', 52.208777, 21.00793],
  ['Politechnika', 'M1', 52.218658, 21.015303],
  ['Centrum', 'M1', 52.231007, 21.010186],
  ['Świętokrzyska', 'M1/M2', 52.235095, 21.007899],
  ['Ratusz-Arsenał', 'M1', 52.245216, 21.000882],
  ['Dworzec Gdański', 'M1', 52.258059, 20.994186],
  ['Plac Wilsona', 'M1', 52.269262, 20.984497],
  ['Marymont', 'M1', 52.271577, 20.97194],
  ['Słodowiec', 'M1', 52.276826, 20.960126],
  ['Stare Bielany', 'M1', 52.281828, 20.949351],
  ['Wawrzyszew', 'M1', 52.286347, 20.939515],
  ['Młociny', 'M1', 52.29077, 20.929868],
  // --- M2 ---
  ['Bemowo', 'M2', 52.239207, 20.915499],
  ['Księcia Janusza', 'M2', 52.239182, 20.944377],
  ['Ulrychów', 'M2', 52.240331, 20.929865],
  ['Młynów', 'M2', 52.237662, 20.960105],
  ['Płocka', 'M2', 52.232454, 20.966385],
  ['Rondo Daszyńskiego', 'M2', 52.230083, 20.982895],
  ['Rondo ONZ', 'M2', 52.233074, 20.998102],
  ['Nowy Świat-Uniwersytet', 'M2', 52.23682, 21.016817],
  ['Centrum Nauki Kopernik', 'M2', 52.239915, 21.031788],
  ['Stadion Narodowy', 'M2', 52.246835, 21.042847],
  ['Dworzec Wileński', 'M2', 52.253777, 21.035797],
  ['Szwedzka', 'M2', 52.263471, 21.045523],
  ['Targówek Mieszkaniowy', 'M2', 52.269252, 21.051366],
  ['Trocka', 'M2', 52.275102, 21.055059],
  ['Zacisze', 'M2', 52.28375, 21.062148],
  ['Kondratowicza', 'M2', 52.292085, 21.048689],
  ['Bródno', 'M2', 52.293585, 21.028939],
];

export function stationCount() {
  return STATIONS.length;
}

// Haversine distance in metres between two WGS84 points.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Nearest Warsaw metro station to a point.
 * @returns {{name, line, distance_m} | null} null when coords are missing.
 */
export function nearestMetro(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;
  const la = +lat, ln = +lng;
  let best = null;
  for (const [name, line, slat, slng] of STATIONS) {
    const distance_m = haversineMeters(la, ln, slat, slng);
    if (!best || distance_m < best.distance_m) best = { name, line, distance_m };
  }
  return best;
}

/**
 * Backfill listings.nearest_metro for active listings that have coordinates
 * but no station yet. Pure local computation (no AI, no network) so the
 * default batch is generous; oldest first for deterministic convergence.
 *
 * @param {number} limit max rows per call (default 500)
 * @returns {Promise<{updated:number, remaining:number}>}
 */
export async function backfillMetro(limit = 500) {
  const rows = await many(
    `SELECT id, lat, lng FROM listings
     WHERE is_active = TRUE
       AND lat IS NOT NULL AND lng IS NOT NULL
       AND nearest_metro IS NULL
     ORDER BY first_seen_at ASC
     LIMIT $1`,
    [limit]
  ).catch(() => []);
  if (!rows.length) return { updated: 0, remaining: 0 };
  let updated = 0;
  for (const r of rows) {
    const m = nearestMetro(r.lat, r.lng);
    if (!m) continue;
    try {
      await query(`UPDATE listings SET nearest_metro = $1::jsonb WHERE id = $2`, [JSON.stringify(m), r.id]);
      updated++;
    } catch { /* keep going — one bad row must not stop the sweep */ }
  }
  // Cheap remaining estimate for the log line (index-backed count).
  let remaining = 0;
  try {
    const c = await query(
      `SELECT COUNT(*)::int AS n FROM listings
       WHERE is_active = TRUE AND lat IS NOT NULL AND lng IS NOT NULL AND nearest_metro IS NULL`
    );
    remaining = c.rows[0]?.n || 0;
  } catch { /* best-effort */ }
  return { updated, remaining };
}
