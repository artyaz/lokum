// Cross-source duplicate detection.
//
// The same flat often appears on several portals (OLX + Otodom + Gratka...).
// We match on independent signals so it works even without coordinates:
//   - geo distance (haversine)          when both sides have coords
//   - street name (normalized)          fallback when no coords
//   - area, rooms, price proximity
//   - title token similarity
//   - image URL similarity              same photos = same flat
// A pair must reach SCORE_THRESHOLD and pass hard gates to be stored.

import { query, one, many } from '../db.js';
import { computePhotoPhash, hammingDistanceHex } from './phash.js';

const GEO_NEAR_M = 120;
const GEO_CLOSE_M = 60;
const SCORE_THRESHOLD = 0.62;

// pHash match confidence (Hamming ≤5 → "same photo" — standard rule-of-thumb
// for 64-bit DCT pHash, per findings/B7-dedupe-audit.md §4 step 5).
const PHASH_HAMMING_THRESHOLD = 5;
const PHASH_MATCH_SCORE = 0.95; // stored on listing_duplicates rows for pHash pairs

// OLX wins dedup — it becomes id_a (the "kept" listing)
const SOURCE_PRIO = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }; // olx, otodom, adresowo, gratka, morizon
function orderPair(a, b) {
  const pa = SOURCE_PRIO[a.source_id] ?? 9;
  const pb = SOURCE_PRIO[b.source_id] ?? 9;
  if (pa !== pb) return pa < pb ? [a.id, b.id] : [b.id, a.id];
  return a.id < b.id ? [a.id, b.id] : [b.id, a.id];
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normStreet(s) {
  if (!s) return null;
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/^ul\.?\s*/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

const streetCache = new WeakMap();
function cachedStreet(listing) {
  if (streetCache.has(listing)) return streetCache.get(listing);
  const value = normStreet(listing.street || listing.address);
  streetCache.set(listing, value);
  return value;
}

function rawTitleTokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  );
}

const titleCache = new WeakMap();
function titleTokens(listing) {
  if (titleCache.has(listing)) return titleCache.get(listing);
  const value = rawTitleTokens(listing.title);
  titleCache.set(listing, value);
  return value;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Normalize an image URL to a comparable key (strip CDN prefix, size params)
function imageKey(url) {
  if (!url) return null;
  return String(url)
    .replace(/^https?:\/\//, '')
    .replace(/^[^/]+\//, '')          // strip domain
    .replace(/[/@]\d+x\d+[^./]*/g, '') // strip size suffixes like /600x450, @2x
    .replace(/\?.*$/, '')              // strip query params
    .replace(/\.(jpg|jpeg|png|webp).*$/i, '') // strip extension
    .toLowerCase();
}

const imageKeyCache = new WeakMap();
function imageKeysFor(listing) {
  if (imageKeyCache.has(listing)) return imageKeyCache.get(listing);
  const value = new Set((listing.images || []).map(imageKey).filter(Boolean));
  imageKeyCache.set(listing, value);
  return value;
}

// Compare two image arrays → overlap ratio (0..1)
function imageOverlap(imgsA, imgsB) {
  if (!imgsA?.length || !imgsB?.length) return 0;
  const keysA = imageKeysFor(imgsA);
  const keysB = imageKeysFor(imgsB);
  if (!keysA.size || !keysB.size) return 0;
  let inter = 0;
  for (const k of keysA) if (keysB.has(k)) inter++;
  return inter / Math.min(keysA.size, keysB.size);
}

// Compare two listing rows → { score, reasons } or null if hard gates fail
export function compareListings(a, b) {
  if (a.source_id === b.source_id) return null;

  const reasons = [];
  let score = 0;

  // --- photos first ---
  // The same flat re-posted on several portals carries the same photos.
  // A strong photo match identifies the flat on its own — portal geo data
  // is often missing or off by hundreds of meters, and address formats
  // differ ("ul. Marszałkowska 1" vs "Marszałkowska 1/2"), so we must NOT
  // gate on location when photos already prove the match.
  const overlap = imageOverlap(a.images, b.images);
  const samePhotos = overlap >= 0.5;

  if (samePhotos) {
    score += 0.85;
    reasons.push('matching photos');
  } else {
    // --- location gate (geo OR street) ---
    const hasGeo = a.lat != null && a.lng != null && b.lat != null && b.lng != null;
    let locScore = 0;
    if (hasGeo) {
      const d = haversineM(a.lat, a.lng, b.lat, b.lng);
      if (d <= GEO_CLOSE_M) { locScore = 0.45; reasons.push(`same spot (${Math.round(d)}m)`); }
      else if (d <= GEO_NEAR_M) { locScore = 0.35; reasons.push(`nearby (${Math.round(d)}m)`); }
      else return null; // too far apart
    }
    const sa = cachedStreet(a);
    const sb = cachedStreet(b);
    if (sa && sb && sa === sb) {
      locScore = Math.max(locScore, 0.3);
      reasons.push(`same street (${a.street || a.address})`);
    } else if (!hasGeo) {
      // no coords anywhere and streets differ/unknown → can't locate
      return null;
    }
    score += locScore;

    if (overlap >= 0.2) { score += 0.1; reasons.push('some shared photos'); }
  }

  // --- rooms gate (relaxed when photos already prove the match —
  //     portals occasionally misreport room counts) ---
  if (a.rooms != null && b.rooms != null) {
    if (a.rooms !== b.rooms) {
      if (!samePhotos) return null;
    } else {
      score += 0.15; reasons.push(`${a.rooms} rooms`);
    }
  }

  // --- area gate (same relaxation) ---
  if (a.area != null && b.area != null) {
    const dA = Math.abs(a.area - b.area);
    if (dA > 4) {
      if (!samePhotos) return null;               // different flat sizes → not the same
    } else if (dA <= 1) { score += 0.2; reasons.push(`area ${a.area}≈${b.area} m²`); }
    else { score += 0.12; reasons.push(`area close (${dA.toFixed(1)} m²)`); }
  }

  // --- price ---
  const dP = Math.abs(a.price - b.price);
  const pPct = dP / Math.max(a.price, b.price);
  if (pPct <= 0.05) { score += 0.15; reasons.push('same price'); }
  else if (pPct <= 0.12) { score += 0.08; reasons.push('similar price'); }

  // --- title similarity ---
  const tj = jaccard(titleTokens(a), titleTokens(b));
  if (tj >= 0.5) { score += 0.05; reasons.push('similar title'); }

  return score >= SCORE_THRESHOLD ? { score: Math.min(1, score), reasons } : null;
}

// Store one detected pair (OLX-priority ordering applied inside).
async function storePair(a, b, m) {
  const [x, y] = orderPair(a, b);
  await query(
    `INSERT INTO listing_duplicates (id_a, id_b, score, reasons)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id_a, id_b) DO UPDATE SET score = EXCLUDED.score, reasons = EXCLUDED.reasons`,
    [x, y, m.score, JSON.stringify(m.reasons)]
  );
}

// Pick the canonical row from a group of duplicates by SOURCE_PRIO, breaking
// ties on oldest first_seen_at (the "OLDER listing wins" rule from the task
// spec). Used by pHash + URL-image paths alike.
function pickCanonical(rows) {
  if (!rows?.length) return null;
  let best = rows[0];
  for (const r of rows) {
    const rp = SOURCE_PRIO[r.source_id] ?? 9;
    const bp = SOURCE_PRIO[best.source_id] ?? 9;
    if (rp < bp) { best = r; continue; }
    if (rp === bp) {
      const rt = r.first_seen_at ? new Date(r.first_seen_at).getTime() : Infinity;
      const bt = best.first_seen_at ? new Date(best.first_seen_at).getTime() : Infinity;
      if (rt < bt) best = r;
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// pHash worker — cross-provider duplicate detection via photo perceptual hash.
// ----------------------------------------------------------------------------
// This is the implementation of the schema B7 prepared in
// 2026_08_dedupe_phash.sql (photo_phash TEXT + duplicate_of_id UUID +
// duplicate_source TEXT). The pipeline:
//
//   1. computeAndStorePhotoPhash(id)   fetch position=0 photo, compute pHash,
//                                       write listings.photo_phash
//   2. findPhashDuplicate(id)          look up active listings with same or
//                                       ≤5-Hamming pHash, set
//                                       duplicate_of_id + duplicate_source
//   3. dedupeByPhash(rows)             scan pass: bucket rows by exact pHash,
//                                       store confirmed pairs in
//                                       listing_duplicates (so they show up
//                                       in getDuplicateGroups)
//   4. getCrossProviderDuplicates(cityId)   inverse-lookup of duplicate_of_id
//                                       for the /api/duplicates UI section
//
// The pHash path runs IN ADDITION to the existing metadata-based pair-scan.
// pHash is a strong signal on its own — when it fires, we mark the duplicate
// and skip the metadata pair-scan for that listing.

// Map source_id → source slug for the duplicate_source column. Fetched lazily
// on first use; cached thereafter.
let _sourceSlugById = null;
async function sourceSlugById(sourceId) {
  if (_sourceSlugById) return _sourceSlugById[sourceId] ?? null;
  const rows = await many(`SELECT id, slug FROM sources`);
  _sourceSlugById = {};
  for (const r of rows) _sourceSlugById[r.id] = r.slug;
  return _sourceSlugById[sourceId] ?? null;
}

/**
 * Fetch the listing's cover photo (position=0), compute its 64-bit pHash,
 * and persist it to listings.photo_phash. Idempotent — returns the phash
 * hex string when the column was set (or already set), or null on failure
 * (no listing, no cover photo, pHash computation error).
 *
 * Task A3: previously returned `boolean`. The only callers needed the phash
 * itself (they did `r.photo_phash = (await one('SELECT photo_phash ...'))
 * immediately afterwards), so returning the value removes one round-trip
 * per new listing in the dedupe worker pool.
 *
 * @param {string} listingId  UUID
 * @returns {Promise<string|null>} 16-char lowercase hex pHash, or null
 */
export async function computeAndStorePhotoPhash(listingId) {
  if (!listingId) return null;
  const row = await one(
    `SELECT l.id, l.photo_phash,
            (SELECT url FROM listing_images li
              WHERE li.listing_id = l.id ORDER BY li.position LIMIT 1) AS photo_url
     FROM listings l WHERE l.id = $1`,
    [listingId]
  );
  if (!row) return null;
  if (row.photo_phash) return row.photo_phash; // already hashed — skip the network round-trip
  if (!row.photo_url) return null;

  const phash = await computePhotoPhash(row.photo_url);
  if (!phash) return null;

  // Task A3: returning the phash (instead of a boolean) lets callers in
  // dedupe.js#dedupeForListings skip a redundant re-SELECT after the worker
  // stores it. The UPDATE's WHERE-guard (photo_phash IS NULL) preserves the
  // "first writer wins" race-safe semantic.
  await query(`UPDATE listings SET photo_phash = $2 WHERE id = $1 AND photo_phash IS NULL`, [
    listingId, phash
  ]);
  return phash;
}

/**
 * Look up active listings in the same city whose pHash matches the target's
 * pHash (exact match OR Hamming distance ≤ PHASH_HAMMING_THRESHOLD). When a
 * match is found, mark the target listing as a duplicate of the canonical
 * row (OLX-priority, then oldest) by setting duplicate_of_id + duplicate_source,
 * AND store the pair in listing_duplicates so it appears in
 * getDuplicateGroups() as well.
 *
 * @param {string} listingId  UUID of the listing whose pHash to match against
 * @returns {Promise<{matched:boolean, canonicalId?:string, hamming?:number}>}
 */
export async function findPhashDuplicate(listingId) {
  const target = await one(
    `SELECT l.id, l.source_id, l.city_id, l.photo_phash, l.first_seen_at
     FROM listings l WHERE l.id = $1 AND l.photo_phash IS NOT NULL`,
    [listingId]
  );
  if (!target || !target.photo_phash) return { matched: false };

  // Pull candidate rows: active, same city, different source, non-null pHash.
  // The city filter keeps the candidate set ≤ ~1k rows even for Warsaw.
  // (Per the task: "JS approach is fine for ~10k listings" — we are well under.)
  const candidates = await many(
    `SELECT l.id, l.source_id, l.city_id, l.photo_phash, l.first_seen_at
     FROM listings l
     WHERE l.is_active = TRUE
       AND l.photo_phash IS NOT NULL
       AND l.id <> $1
       AND l.city_id = $2
     ORDER BY l.first_seen_at ASC
     LIMIT 1000`,
    [target.id, target.city_id]
  );

  // Hamming-filter in JS.
  const matches = [];
  let bestHamming = 65;
  for (const c of candidates) {
    if (c.source_id === target.source_id) continue; // same source already excluded in SQL, belt+suspenders
    const d = hammingDistanceHex(target.photo_phash, c.photo_phash);
    if (d <= PHASH_HAMMING_THRESHOLD) {
      matches.push({ ...c, hamming: d });
      if (d < bestHamming) bestHamming = d;
    }
  }
  if (!matches.length) return { matched: false };

  // The canonical row is the OLDEST listing among {target + matches}.
  // (Per task: "The OLDER listing wins.") pickCanonical applies SOURCE_PRIO
  // first, then oldest first_seen_at — SOURCE_PRIO means an OLX listing
  // beats an Otodom listing even if Otodom was inserted earlier, which is
  // the long-standing Lokum convention.
  const all = [...matches, { id: target.id, source_id: target.source_id, city_id: target.city_id, photo_phash: target.photo_phash, first_seen_at: target.first_seen_at }];
  const canonical = pickCanonical(all);

  // If the target itself is the canonical (e.g. an OLX listing just inserted
  // whose pHash matches an older Otodom listing), the target should NOT be
  // marked as a duplicate — instead, the older non-canonical matches should
  // be re-pointed at the target. We do that repointing here so the new
  // canonical takes over cleanly.
  if (canonical.id === target.id) {
    const slug = await sourceSlugById(target.source_id);
    for (const m of matches) {
      if (m.id === target.id) continue;
      const mPrio = SOURCE_PRIO[m.source_id] ?? 9;
      const tPrio = SOURCE_PRIO[target.source_id] ?? 9;
      // Only repoint rows the target outranks (so we don't churn ties).
      if (tPrio >= mPrio) continue;
      await query(
        `UPDATE listings SET duplicate_of_id = $2, duplicate_source = $3
         WHERE id = $1 AND duplicate_of_id IS DISTINCT FROM $2`,
        [m.id, target.id, slug]
      );
      // Also upsert the pair so the union-find UI stays consistent.
      await storePair(
        { id: target.id, source_id: target.source_id },
        { id: m.id, source_id: m.source_id },
        { score: PHASH_MATCH_SCORE, reasons: ['phash match', `Hamming ${m.hamming}`] }
      ).catch(() => {});
    }
    return { matched: true, canonicalId: target.id, hamming: bestHamming, repointed: matches.length };
  }

  // Target is NOT canonical — mark it as a duplicate of the canonical.
  const slug = await sourceSlugById(canonical.source_id);
  await query(
    `UPDATE listings SET duplicate_of_id = $2, duplicate_source = $3 WHERE id = $1`,
    [target.id, canonical.id, slug]
  );
  await storePair(
    { id: target.id, source_id: target.source_id },
    { id: canonical.id, source_id: canonical.source_id },
    { score: PHASH_MATCH_SCORE, reasons: ['phash match', `Hamming ${bestHamming}`] }
  ).catch(() => {});
  return { matched: true, canonicalId: canonical.id, hamming: bestHamming };
}

/**
 * Scan pass: group rows by exact photo_phash. Any bucket with rows from ≥2
 * distinct sources is a confirmed cross-provider duplicate family. We:
 *   - pick the canonical (pickCanonical)
 *   - set duplicate_of_id + duplicate_source on every non-canonical row
 *   - store every (canonical, dup) pair in listing_duplicates so the
 *     union-find in getDuplicateGroups stays consistent
 * Pairs within Hamming ≤5 but different exact pHash are also caught by
 * findPhashDuplicate at insert time; this scan mainly backfills historical
 * rows whose pHash was set during a backfill run.
 *
 * @param {Array} rows  active listing rows (must include id, source_id, photo_phash, first_seen_at)
 * @returns {Promise<number>}  pair count stored
 */
async function dedupeByPhash(rows) {
  const byPhash = new Map();
  for (const r of rows) {
    if (!r.photo_phash) continue;
    (byPhash.get(r.photo_phash) || byPhash.set(r.photo_phash, []).get(r.photo_phash)).push(r);
  }
  let pairs = 0;
  for (const group of byPhash.values()) {
    if (group.length < 2) continue;
    const sources = new Set(group.map(r => r.source_id));
    if (sources.size < 2) continue; // same source already — internal dupe, handled elsewhere
    const canonical = pickCanonical(group);
    const slug = await sourceSlugById(canonical.source_id);
    for (const r of group) {
      if (r.id === canonical.id) continue;
      await query(
        `UPDATE listings SET duplicate_of_id = $2, duplicate_source = $3
         WHERE id = $1 AND duplicate_of_id IS DISTINCT FROM $2`,
        [r.id, canonical.id, slug]
      ).catch(() => {});
      await storePair(
        { id: r.id, source_id: r.source_id },
        { id: canonical.id, source_id: canonical.source_id },
        { score: PHASH_MATCH_SCORE, reasons: ['phash match (exact)'] }
      ).catch(() => {});
      pairs++;
    }
  }
  return pairs;
}

/**
 * Backfill worker — for every active listing with photo_phash IS NULL,
 * compute + store its pHash, then run findPhashDuplicate on it. Used by the
 * admin endpoint POST /api/duplicates/phash-backfill to backfill historical
 * rows that pre-date this worker.
 *
 * @param {{limit?:number, cityId?:number}} opts
 * @returns {Promise<{hashed:number, matched:number, scanned:number, failed:number}>}
 */
export async function phashBackfill({ limit = 200, cityId = null } = {}) {
  const rows = await many(
    `SELECT id FROM listings
     WHERE is_active = TRUE AND photo_phash IS NULL
       ${cityId ? 'AND city_id = $2' : ''}
     ORDER BY first_seen_at DESC
     LIMIT $1`,
    cityId ? [limit, cityId] : [limit]
  );
  const result = { hashed: 0, matched: 0, scanned: rows.length, failed: 0 };
  for (const r of rows) {
    try {
      const phash = await computeAndStorePhotoPhash(r.id);
      if (phash) result.hashed++;
      else { result.failed++; continue; }
      const m = await findPhashDuplicate(r.id);
      if (m.matched) result.matched++;
    } catch (e) {
      result.failed++;
      console.warn('[dedupe] phash backfill error for', r.id, e.message);
    }
  }
  return result;
}

/**
 * For the /api/duplicates route — fetch listings flagged as cross-provider
 * duplicates (via duplicate_of_id) and group them by their canonical listing.
 * Each group emits:
 *   { canonical: {id,title,price,rooms,area,url,image,source:{slug,name,color}},
 *     duplicates: [ {id,title,...,duplicateSource}, ... ] }
 *
 * @param {number} cityId
 * @returns {Promise<Array>}
 */
export async function getCrossProviderDuplicates(cityId) {
  const rows = await many(
    `SELECT l.id, l.title, l.price, l.rooms, l.area, l.url, l.duplicate_source,
            l.duplicate_of_id,
            s.slug AS source_slug, s.name AS source_name, s.color AS source_color,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li.position LIMIT 1) AS image
     FROM listings l
     JOIN sources s ON s.id = l.source_id
     WHERE l.duplicate_of_id IS NOT NULL
       AND l.is_active = TRUE
       AND l.city_id = $1
     ORDER BY l.first_seen_at DESC`,
    [cityId]
  );
  if (!rows.length) return [];

  // Fetch canonical rows in one shot.
  const canonicalIds = [...new Set(rows.map(r => r.duplicate_of_id))];
  const canonRows = await many(
    `SELECT l.id, l.title, l.price, l.rooms, l.area, l.url,
            s.slug AS source_slug, s.name AS source_name, s.color AS source_color,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li.position LIMIT 1) AS image
     FROM listings l
     JOIN sources s ON s.id = l.source_id
     WHERE l.id = ANY($1::uuid[])`,
    [canonicalIds]
  );
  const byCanonId = Object.fromEntries(canonRows.map(r => [r.id, r]));

  const byGroup = new Map();
  for (const r of rows) {
    const canon = byGroup.get(r.duplicate_of_id) || (byGroup.set(r.duplicate_of_id, { canonical: byCanonId[r.duplicate_of_id], duplicates: [] }).get(r.duplicate_of_id));
    canon.duplicates.push({
      id: r.id, title: r.title, price: r.price, rooms: r.rooms, area: r.area, url: r.url,
      image: r.image, source: { slug: r.source_slug, name: r.source_name, color: r.source_color },
      duplicateSource: r.duplicate_source
    });
  }

  return [...byGroup.values()].map(g => ({
    canonical: {
      id: g.canonical.id, title: g.canonical.title, price: g.canonical.price,
      rooms: g.canonical.rooms, area: g.canonical.area, url: g.canonical.url,
      image: g.canonical.image,
      source: { slug: g.canonical.source_slug, name: g.canonical.source_name, color: g.canonical.source_color }
    },
    duplicates: g.duplicates
  }));
}

// Image-first pass: listings on different sources that share a photo are
// the same flat, even when metadata (rooms/area/geo) disagrees or is
// missing. Skips image keys seen on too many listings (placeholder photos).
async function dedupeByImages(rows) {
  const byImage = new Map();
  for (const r of rows) {
    for (const k of imageKeysFor(r)) {
      if (!k) continue;
      (byImage.get(k) || byImage.set(k, []).get(k)).push(r);
    }
  }
  let pairs = 0;
  for (const group of byImage.values()) {
    if (group.length < 2 || group.length > 8) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.source_id === b.source_id) continue;
        const m = compareListings(a, b);
        if (!m) continue;
        await storePair(a, b, m);
        pairs++;
      }
    }
  }
  return pairs;
}

// Find + store duplicates for a set of listing ids (e.g. new listings of a run)
export async function dedupeForListings(listingIds) {
  if (!listingIds?.length) return 0;
  // Task A3: include l.duplicate_of_id in the SELECT so the metadata
  // pair-scan can skip listings already marked as pHash duplicates WITHOUT
  // a per-listing SELECT (was N+1 — one query per new listing just to read
  // a column we already had on the row above).
  const rows = await many(
    `SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.lat, l.lng, l.street, l.address,
            l.photo_phash, l.first_seen_at, l.duplicate_of_id,
            COALESCE(array_agg(li.url) FILTER (WHERE li.url IS NOT NULL), '{}') AS images
     FROM listings l
     LEFT JOIN listing_images li ON li.listing_id = l.id
     WHERE l.id = ANY($1::uuid[]) AND l.is_active = TRUE
     GROUP BY l.id`,
    [listingIds]
  );

  // ----- pHash worker pass -----
  // For each new listing, compute + store its pHash (network-bound — bounded
  // pool of 4 keeps peak memory + concurrent fetches reasonable) and then
  // run the cross-provider check. pHash is a strong enough signal that when
  // it fires we can skip the metadata pair-scan for that listing.
  let phashPairs = 0;
  const phashPromises = [];
  let phashIdx = 0;
  async function phashWorker() {
    while (phashIdx < rows.length) {
      const r = rows[phashIdx++];
      try {
        // Task A3: computeAndStorePhotoPhash now returns the stored phash
        // directly (was: returned boolean, then a second SELECT to fetch
        // the phash we just wrote). One fewer round-trip per new listing.
        if (!r.photo_phash) {
          r.photo_phash = await computeAndStorePhotoPhash(r.id);
        }
        if (!r.photo_phash) continue;
        const m = await findPhashDuplicate(r.id);
        if (m.matched) phashPairs++;
      } catch (e) {
        // swallow — pHash worker errors must not block the metadata pair-scan
        console.warn('[dedupe] phash worker error for', r.id, e.message);
      }
    }
  }
  const N_WORKERS = Math.min(4, rows.length);
  for (let i = 0; i < N_WORKERS; i++) phashPromises.push(phashWorker());
  await Promise.all(phashPromises);

  // ----- metadata pair-scan (existing logic, unchanged) -----
  let pairs = 0;
  for (const l of rows) {
    // Skip listings already marked as a pHash duplicate — the cross-provider
    // match is stored in listing_duplicates by findPhashDuplicate, so the
    // union-find UI already has the pair. Running the metadata scan here
    // would just produce a second (lower-confidence) opinion on the same pair.
    //
    // Task A3: l.duplicate_of_id is now on the row from the SELECT above,
    // so this check is a no-DB-lookup read of an in-memory field (was:
    // `await one('SELECT duplicate_of_id FROM listings WHERE id = $1')`
    // — one query per new listing).
    if (l.duplicate_of_id) continue;

    const seen = new Set([l.id]);
    const candidates = await many(
      `SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.lat, l.lng, l.street, l.address,
              COALESCE(array_agg(li.url) FILTER (WHERE li.url IS NOT NULL), '{}') AS images
       FROM listings l
       LEFT JOIN listing_images li ON li.listing_id = l.id
       WHERE l.is_active = TRUE AND l.city_id = $1 AND l.id != $2
         AND l.source_id != $3
         AND l.rooms IS NOT DISTINCT FROM $4
         AND l.price BETWEEN $5 AND $6
       GROUP BY l.id`,
      [
        l.city_id, l.id, l.source_id, l.rooms,
        Math.round(l.price * 0.85), Math.round(l.price * 1.15)
      ]
    );
    for (const c of candidates) seen.add(c.id);

    // Photo-based candidates: same flat re-posted elsewhere may have
    // different rooms/price metadata and never enter the SQL candidate set.
    if (l.images?.length) {
      const imgRows = await many(
        `SELECT DISTINCT listing_id FROM listing_images
         WHERE url = ANY($1::text[]) AND listing_id != $2`,
        [l.images, l.id]
      );
      const extraIds = imgRows.map(r => r.listing_id).filter(id => !seen.has(id));
      if (extraIds.length) {
        const extra = await many(
          `SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.lat, l.lng, l.street, l.address,
                  COALESCE(array_agg(li.url) FILTER (WHERE li.url IS NOT NULL), '{}') AS images
           FROM listings l
           LEFT JOIN listing_images li ON li.listing_id = l.id
           WHERE l.id = ANY($1::uuid[])
           GROUP BY l.id`,
          [extraIds]
        );
        candidates.push(...extra);
      }
    }

    for (const c of candidates) {
      if (c.source_id === l.source_id) continue;
      const m = compareListings(l, c);
      if (!m) continue;
      await storePair(l, c, m);
      pairs++;
    }
  }
  return pairs + phashPairs;
}

// Cross-run dedup: scan ALL active listings (not just new ones from current run).
// This catches duplicates where both listings were added in different runs,
// or where enrichment just gave one of them coordinates for the first time.
// Bounded to recent listings to keep runtime reasonable.
export async function dedupeCrossRun(cityIds = null) {
  // A normal cycle only needs to rescan cities that received new listings. Full
  // scans remain available to admin callers by omitting cityIds.
  const cities = cityIds?.length
    ? cityIds
    : (await many(`SELECT DISTINCT city_id FROM listings WHERE is_active = TRUE`)).map(r => r.city_id);
  let totalPairs = 0;
  for (const cityId of cities) {
    const pairs = await dedupeScanCity(cityId);
    totalPairs += pairs;
  }
  return totalPairs;
}

// Full rescan for a city (Rescan button) — bucketed by rooms to avoid O(n²)
export async function dedupeScanCity(cityId) {
  const rows = await many(
    `SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.lat, l.lng, l.street, l.address,
            l.photo_phash, l.first_seen_at,
            COALESCE(array_agg(li.url) FILTER (WHERE li.url IS NOT NULL), '{}') AS images
     FROM listings l
     LEFT JOIN listing_images li ON li.listing_id = l.id
     WHERE l.is_active = TRUE AND l.city_id = $1
     GROUP BY l.id
     ORDER BY l.first_seen_at DESC LIMIT 500`,
    [cityId]
  );
  // Bucket by rooms so we only compare listings with same room count
  const buckets = new Map();
  for (const r of rows) {
    const key = r.rooms ?? 'null';
    (buckets.get(key) || buckets.set(key, []).get(key)).push(r);
  }
  let pairs = 0;
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        if (a.source_id === b.source_id) continue;
        if (Math.abs(a.price - b.price) / Math.max(a.price, b.price) > 0.15) continue;
        if (a.area != null && b.area != null && Math.abs(a.area - b.area) > 4) continue;
        const m = compareListings(a, b);
        if (!m) continue;
        await storePair(a, b, m);
        pairs++;
      }
    }
  }

  // Image-first pass catches same-flat pairs whose metadata (rooms, price,
  // area) disagrees too much for the bucketed pass above.
  pairs += await dedupeByImages(rows);

  // pHash pass — bucket rows by exact photo_phash and store cross-provider
  // pairs (also sets listings.duplicate_of_id / duplicate_source on the
  // non-canonical rows). Catches pairs that the metadata bucketing above
  // misses because metadata diverges across providers.
  pairs += await dedupeByPhash(rows);
  return pairs;
}

// Build duplicate groups (union-find) for a city, with display-ready listings
export async function getDuplicateGroups(cityId) {
  const pairs = await many(
    `SELECT d.id_a, d.id_b, d.score, d.reasons
     FROM listing_duplicates d
     JOIN listings la ON la.id = d.id_a AND la.is_active = TRUE
     JOIN listings lb ON lb.id = d.id_b AND lb.is_active = TRUE
     WHERE la.city_id = $1`,
    [cityId]
  );
  if (!pairs.length) return [];

  // union-find
  const parent = {};
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (const p of pairs) {
    parent[p.id_a] = p.id_a; parent[p.id_b] = p.id_b;
  }
  for (const p of pairs) union(p.id_a, p.id_b);

  const groupsMap = {};
  const scoreMap = {};
  for (const p of pairs) {
    const root = find(p.id_a);
    (groupsMap[root] ||= new Set()).add(p.id_a).add(p.id_b);
    scoreMap[root] = Math.max(scoreMap[root] || 0, p.score);
  }

  const allIds = [...new Set(pairs.flatMap(p => [p.id_a, p.id_b]))];
  const listings = await many(
    `SELECT l.id, l.title, l.price, l.rooms, l.area, l.district, l.url,
            s.name AS source_name, s.color AS source_color, s.slug AS source_slug,
            (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) AS image
     FROM listings l JOIN sources s ON s.id = l.source_id
     WHERE l.id = ANY($1::uuid[])`,
    [allIds]
  );
  const byId = Object.fromEntries(listings.map(l => [l.id, l]));

  // OLX is the most reliable source — it leads the group, rest by price
  const SOURCE_PRIORITY = { olx: 0, otodom: 1, adresowo: 2, gratka: 3, morizon: 4, community: 5 };
  const prio = (l) => SOURCE_PRIORITY[l.source_slug] ?? 9;

  const groups = Object.entries(groupsMap).map(([root, ids], i) => ({
    id: root,
    score: scoreMap[root] || 0,
    listings: [...ids].map(id => byId[id]).filter(Boolean)
      .sort((a, b) => (prio(a) - prio(b)) || (a.price - b.price))
      .map(l => ({
        id: l.id, title: l.title, price: l.price, rooms: l.rooms, area: l.area,
        district: l.district, url: l.url,
        images: l.image ? [l.image] : [],
        source: { name: l.source_name, color: l.source_color, slug: l.source_slug }
      }))
  })).filter(g => g.listings.length > 1);

  groups.sort((a, b) => b.score - a.score);
  return groups;
}
