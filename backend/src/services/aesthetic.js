// Aesthetic vision rating — TOP PICK topping.
//
// Eligible rentals (active, with photos, not yet rated):
//   - total all-in monthly price < 3000 PLN, OR
//   - near a metro station (nearest_metro.distance_m <= METRO_NEAR_M), OR
//   - close to the city centre (haversine to cities.lat/lng <= CENTRUM_NEAR_M).
//
// Eligible listings get up to AESTHETIC_IMAGES photos sent to the vision
// model (OpenAI GPT Luna via the ai-client seam, multimodal content parts)
// which rates how modern and clean (aesthetically) the place looks, 1-10.
// The score is always stored (aesthetic_score + aesthetic_rated_at); the
// best (score >= AESTHETIC_TOP_SCORE) are flagged topped=TRUE so the feed
// orders them first with the TOP PICK chip.
//
// Bounded per run (AESTHETIC_PER_RUN) — vision calls are the priciest AI
// calls in the pipeline. Runs oldest-first so coverage converges.

import { query, many } from '../db.js';
import { callAI } from './ai-client.js';
import { haversineMeters } from './metro.js';

const PRICE_CUTOFF = parseInt(process.env.AESTHETIC_PRICE_CUTOFF || '3000', 10);
const METRO_NEAR_M = parseInt(process.env.METRO_NEAR_M || '800', 10);
const CENTRUM_NEAR_M = parseInt(process.env.CENTRUM_NEAR_M || '2500', 10);
const TOP_SCORE = parseInt(process.env.AESTHETIC_TOP_SCORE || '8', 10);
const MAX_IMAGES = Math.min(5, Math.max(1, parseInt(process.env.AESTHETIC_IMAGES || '3', 10)));

const SYSTEM = `You rate rental listing photos for how modern and clean (aesthetically pleasing) the place looks.
Consider: brightness and natural light, modern furniture and finishes, cleanliness and tidiness,
photo quality and staging. Ignore people, pets, and watermarks.

Output ONLY strict JSON, no markdown, no code fences:
{"score": <int 1-10>, "notes": "<one short English sentence or null>"}

Scale: 1-3 dated or messy, 4-5 average, 6-7 nice and clean, 8-10 strikingly modern and spotless.`;

/**
 * Pure eligibility check (exported for tests).
 * @param {{total_estimate:number|null, metro_distance_m:number|null, centrum_distance_m:number|null}} l
 */
export function isEligible(l) {
  if (l.total_estimate != null && l.total_estimate < PRICE_CUTOFF) return true;
  if (l.metro_distance_m != null && l.metro_distance_m <= METRO_NEAR_M) return true;
  if (l.centrum_distance_m != null && l.centrum_distance_m <= CENTRUM_NEAR_M) return true;
  return false;
}

/** Tolerant parse of the {score, notes} JSON (exported for tests). */
export function parseRating(content) {
  if (!content) return null;
  const txt = String(content).replace(/```(?:json)?/g, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[0]); } catch { return null; }
  const score = Math.round(Number(p.score));
  if (!Number.isFinite(score) || score < 1 || score > 10) return null;
  return { score, notes: p.notes ? String(p.notes).slice(0, 300) : null };
}

async function rateImages(imageUrls, price) {
  const urls = (imageUrls || []).filter(Boolean).slice(0, MAX_IMAGES);
  if (!urls.length) return null;
  const userContent = [
    {
      type: 'text',
      text: `Rate how modern and clean this ${price ? `~${price} PLN/month ` : ''}rental looks from these ${urls.length} photo(s). Output ONLY the JSON.`
    },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
  const content = await callAI({
    system: SYSTEM,
    user: `[${urls.length} listing photos attached]`,
    opts: { userContent, maxTokens: 512, temperature: 0.2 }
  });
  return parseRating(content);
}

/**
 * Rate one backlog batch of eligible listings.
 * @param {number} limit max listings rated per call (default 20)
 * @returns {Promise<{rated:number, topped:number, failed:number, aiCalls:number}>}
 */
export async function rateAestheticBacklog(limit = 20) {
  const result = { rated: 0, topped: 0, failed: 0, aiCalls: 0 };
  if (!(limit > 0)) return result;

  // Oversample (3x): eligibility needs metro/centrum distances computed in
  // JS, so fetch more candidates than we will rate and filter down.
  const candidates = await many(
    `SELECT l.id, l.price, l.total_estimate, l.nearest_metro, l.lat, l.lng,
            c.lat AS city_lat, c.lng AS city_lng
     FROM listings l
     JOIN cities c ON c.id = l.city_id
     WHERE l.is_active = TRUE
       AND l.aesthetic_rated_at IS NULL
       AND EXISTS (SELECT 1 FROM listing_images WHERE listing_id = l.id)
     ORDER BY l.first_seen_at ASC
     LIMIT $1`,
    [limit * 3]
  ).catch(() => []);
  if (!candidates.length) return result;

  const eligible = [];
  for (const c of candidates) {
    let metro = null;
    try {
      const nm = typeof c.nearest_metro === 'string' ? JSON.parse(c.nearest_metro) : c.nearest_metro;
      metro = nm && Number.isFinite(+nm.distance_m) ? +nm.distance_m : null;
    } catch { metro = null; }
    const centrum =
      c.lat != null && c.lng != null && c.city_lat != null && c.city_lng != null
        ? haversineMeters(+c.lat, +c.lng, +c.city_lat, +c.city_lng)
        : null;
    if (isEligible({ total_estimate: c.total_estimate, metro_distance_m: metro, centrum_distance_m: centrum })) {
      eligible.push(c);
    }
    if (eligible.length >= limit) break;
  }
  if (!eligible.length) return result;

  // Bulk-load up to MAX_IMAGES photo urls per eligible listing (one query).
  const imgRows = await many(
    `SELECT listing_id, url FROM (
       SELECT listing_id, url,
              ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY position ASC) AS rn
       FROM listing_images WHERE listing_id = ANY($1::uuid[])
     ) t WHERE rn <= $2`,
    [eligible.map((e) => e.id), MAX_IMAGES]
  ).catch(() => []);
  const imgsById = new Map();
  for (const r of imgRows) {
    if (!imgsById.has(r.listing_id)) imgsById.set(r.listing_id, []);
    imgsById.get(r.listing_id).push(r.url);
  }

  for (const c of eligible) {
    const urls = imgsById.get(c.id) || [];
    if (!urls.length) continue;
    result.aiCalls += 1;
    try {
      const rating = await rateImages(urls, c.total_estimate || c.price);
      if (!rating) { result.failed++; continue; }
      const topped = rating.score >= TOP_SCORE;
      await query(
        `UPDATE listings
         SET aesthetic_score = $1, aesthetic_rated_at = NOW(), topped = $2
         WHERE id = $3`,
        [rating.score, topped, c.id]
      );
      result.rated++;
      if (topped) result.topped++;
    } catch (e) {
      console.warn(`[aesthetic] rating failed (${e.code || e.message})`);
      result.failed++;
    }
  }
  return result;
}
