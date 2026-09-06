// AI-powered "all-in" monthly cost estimation.
//
// Reads the listing description + params (Polish) and extracts every recurring
// monthly cost on top of the rent: administrative fee (czynsz administracyjny),
// utilities (media: prąd, woda, gaz, internet), parking, extra fees. When a cost
// is mentioned without an amount ("prąd wg licznika"), the model estimates a
// typical value for a flat of that size and marks it as estimated.
//
// Result is stored on listings: total_estimate (INT, rent + extras) and
// total_breakdown (JSONB) — shown in the feed as the prominent total monthly
// price + breakdown chips (rent | admin fee | utilities | parking | extras).
//
// *** AI CALLS GO THROUGH services/ai-client.js (the single seam). ***
// - 15s hard timeout (Promise.race with setTimeout)
// - circuit breaker (3 consecutive failures -> skip AI for 5 min)
// - cache: listings.total_estimate NOT NULL means skip (already computed)
// - batching: computeForListings chunks N listings into batches of 5,
//   one LLM call per batch (JSON array response), instead of N calls.
// - regex fallback: if the AI call fails or returns invalid JSON, fall back to
//   extractFromRegex() — cheap, deterministic, no AI cost.

import { query, one, many } from '../db.js';
import { callAI } from './ai-client.js';

const MAX_EXTRA = 4000; // sanity clamp for the sum of extras
const BATCH_SIZE = 5;
const MAX_BATCH_INPUT_CHARS = 24000;
const CURRENCY = 'PLN';

// --- Output shape (stored in listings.total_breakdown JSONB) ----------------
// {
//   rent:        int              = listing.price
//   admin_fee:   int | null        czynsz administracyjny / housing-community fee
//   utilities:   int | null        media (water, heating, garbage) bundle
//   parking:     int | null        mandatory monthly parking
//   extras:      [{name, amount, estimated?}]   everything else recurring monthly
//   total_monthly: int             rent + admin_fee + utilities + parking + sum(extras)
//   currency:    'PLN'
//   notes:       string | null     one short English sentence
//   computed_at: ISO8601
// }
//
// The user reported a double-count bug: when the listing says e.g.
// "czynsz 2500 + 500 administracyjne" (rent 2500 + admin 500 = 3000 total),
// the previous AI prompt sometimes returned items=[{Administrative fee, 500},
// {Administrative fee, 500}] -> total 3500 instead of 3000. The new prompt
// makes the no-double-count rule explicit and asks for a structured shape that
// forces the model to pick ONE bucket per fee.

const SYSTEM = `You analyze Polish rental listings and extract the tenant's TOTAL monthly cost.

Find every recurring monthly charge and classify it into EXACTLY ONE of these buckets:
- admin_fee     -> czynsz administracyjny / administrative rent / housing-community fee
                   (the building-maintenance fee, distinct from the advertised rent)
- utilities     -> media / water+waste+heating+garbage bundle (a single combined amount)
- parking       -> miejsce parkingowe (only if stated as a MANDATORY monthly cost)
- extras[]      -> any OTHER recurring monthly charge not covered above, each item
                   {name: short English label, amount: int PLN, estimated?: bool}

Output ONLY strict JSON, no markdown, no code fences:
{
  "rent":        <int>,           // the advertised monthly rent from the listing
  "admin_fee":   <int|null>,     // NULL if not mentioned
  "utilities":   <int|null>,
  "parking":     <int|null>,
  "extras":      [{"name":"Internet","amount":60,"estimated":false}, ...],
  "total_monthly": <int>,        // rent + admin_fee + utilities + parking + sum(extras)
  "currency":    "PLN",
  "notes":       "one short English sentence, or null"
}

CRITICAL — DO NOT DOUBLE-COUNT THE ADMINISTRATIVE FEE:
- If the listing says e.g. "czynsz 2500 + 500 administracyjne", that means
  rent=2500, admin_fee=500, total_monthly=3000 — NOT 3500.
- The advertised rent (the headline price) is the BASE. admin_fee is the
  building-maintenance fee ON TOP of it. Do not also list admin_fee in extras[].
- If the same fee appears multiple times in the listing text (e.g. once in the
  header "Czynsz 2500 + 500 admin" and once in the body "opłata administracyjna
  500 zł"), count it ONCE — in admin_fee only.
- The rent itself NEVER appears in extras[] or in any other bucket.

Other rules:
- Only include costs explicitly mentioned or clearly implied. Do NOT include the
  one-time deposit (kaucja).
- If a cost is mentioned WITHOUT an amount (e.g. "prąd wg licznika",
  "media dodatkowo płatne"), estimate a typical monthly amount for a flat of
  that size and mark estimated=true. Electricity for a 30-50 m² flat is
  typically 120-220 PLN; utilities bundle 150-350 PLN; internet 50-80 PLN.
- If the rent explicitly INCLUDES a cost ("w cenie", "w czynszu",
  "all included"), do not list it.
- If NO extra costs are mentioned anywhere, return admin_fee/utilities/parking
  all NULL and extras=[]; total_monthly = rent.
- All amounts are integers in PLN. Labels in extras are short English.`;

const BATCH_SYSTEM = `You analyze Polish rental listings and extract the tenant's TOTAL monthly cost.
Same rules as the single-listing task. Find every recurring monthly charge and classify it into
EXACTLY ONE bucket:
  - admin_fee   -> czynsz administracyjny / housing-community fee (NOT the advertised rent)
  - utilities   -> media (water+heating+garbage) combined
  - parking     -> mandatory monthly parking only
  - extras[]    -> any other recurring monthly charge, each {name, amount, estimated?}

CRITICAL — DO NOT DOUBLE-COUNT THE ADMINISTRATIVE FEE:
- "czynsz 2500 + 500 administracyjne" => rent=2500, admin_fee=500, total_monthly=3000 (NOT 3500).
- The advertised rent is the BASE. admin_fee is ON TOP. Do NOT also list admin_fee in extras[].
- If a fee appears multiple times in the listing text, count it ONCE in its single bucket.
- The rent itself NEVER appears in extras[] or any other bucket.

Other rules:
- Skip one-time deposit (kaucja).
- If a cost has no amount, estimate typical monthly PLN for a flat of that size, mark estimated=true.
- "w cenie" / "w czynszu" / "all included" => that cost is in the rent, do not list separately.
- If no extras mentioned, return admin_fee/utilities/parking all null and extras=[]; total_monthly=rent.

For a BATCH of listings, respond with a STRICT JSON ARRAY — one object per input
listing, in the SAME ORDER as the input. Each object has the SAME shape as the
single-listing response:
{"id": <int 0-based>, "rent": <int>, "admin_fee": <int|null>, "utilities": <int|null>,
 "parking": <int|null>, "extras": [{"name":"...","amount":int,"estimated":bool}],
 "total_monthly": <int>, "currency":"PLN", "notes": "one short sentence or null"}

Output ONLY the JSON array. No markdown. No code fences. No preamble.`;

function buildPrompt(listing) {
  const params = (listing.params || []).map(p => `${p.name || p.label}: ${p.value}`).join('\n');
  return [
    `Advertised rent: ${listing.price} PLN/month`,
    listing.area ? `Area: ${listing.area} m²` : '',
    listing.rooms ? `Rooms: ${listing.rooms}` : '',
    params ? `Parameters:\n${params}` : '',
    listing.description ? `Description:\n${listing.description.slice(0, 4000)}` : ''
  ].filter(Boolean).join('\n');
}

function buildBatchPrompt(jobs) {
  // jobs: [{ idx, listingId, listing }]
  const perListing = Math.max(800, Math.floor(MAX_BATCH_INPUT_CHARS / jobs.length));
  const lines = [`Analyze the following ${jobs.length} listings. Respond with a JSON array of {id, rent, admin_fee, utilities, parking, extras, total_monthly, currency, notes} in the same order as input.`];
  for (const j of jobs) {
    const params = (j.listing.params || []).map(p => `${p.name || p.label}: ${p.value}`).join('\n');
    const desc = (j.listing.description || '').slice(0, perListing - 400);
    lines.push(`\n=== LISTING id=${j.idx} ===`);
    lines.push(`Advertised rent: ${j.listing.price} PLN/month`);
    if (j.listing.area) lines.push(`Area: ${j.listing.area} m²`);
    if (j.listing.rooms) lines.push(`Rooms: ${j.listing.rooms}`);
    if (params) lines.push(`Parameters:\n${params}`);
    if (desc) lines.push(`Description:\n${desc}`);
  }
  return lines.join('\n');
}

// Pluck an integer field from a parsed object, tolerating null/undefined/string.
function pickInt(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Normalize a parsed AI response into the strict shape we store. Defensive:
 * clamps huge numbers, drops negative entries, caps extras count.
 */
function clampResult(parsed, price) {
  if (!parsed || typeof parsed !== 'object') return null;
  const rent = price; // advertised rent is the listing.price, always
  const admin_fee = pickInt(parsed.admin_fee);
  const utilities = pickInt(parsed.utilities);
  const parking = pickInt(parsed.parking);

  let extras = Array.isArray(parsed.extras) ? parsed.extras : [];
  extras = extras
    .map(it => {
      if (!it || typeof it !== 'object') return null;
      const name = String(it.name || it.label || 'Fee').slice(0, 80);
      const amount = pickInt(it.amount != null ? it.amount : it.amount_pln);
      if (amount == null || amount <= 0 || amount > 2000) return null;
      return { name, amount, estimated: !!it.estimated };
    })
    .filter(Boolean)
    .slice(0, 8);

  // sanity: don't let extras explode the total
  let extraSum = extras.reduce((a, b) => a + b.amount, 0);
  while (extraSum > MAX_EXTRA && extras.length) {
    extras.pop();
    extraSum = extras.reduce((a, b) => a + b.amount, 0);
  }

  // The model sometimes echoes admin_fee / rent into extras[] as well — strip
  // the duplicate so the displayed total stays honest. Drop any extras whose
  // name strongly suggests one of the dedicated buckets (rent / admin / kaucja
  // / deposit) — those belong in those buckets, not in extras[].
  //
  // Family regex covers both Polish and English variants of every fee family
  // so we can dedupe by (family, amount) — the AI often lists the same charge
  // twice under slightly different labels (e.g. "Electricity" + "Prąd" both at
  // 150 PLN, or "Administrative fee" 600 in admin_fee AND 600 in extras[]).
  // The family map collapses these to a single line item per (family, amount).
  const NON_EXTRA_RE = /admin|housing|community|building\s+fee|czynsz|^rent$|the\s+rent|rent\s+\(monthly\)|lease\s+amount|rent\s+amount|kaucj|deposit|security|wynajem/i;
  extras = extras.filter(e => !NON_EXTRA_RE.test(String(e.name)));
  // Drop any extra whose amount exactly matches the rent — almost certainly the
  // AI misreading the rent row as an extra. Acceptable trade-off: a real admin
  // fee that happens to equal the rent exactly is essentially impossible.
  extras = extras.filter(e => e.amount !== rent);

  // (family, amount) dedupe for extras. Within a family, the non-estimated
  // entry wins if both estimated and non-estimated versions exist.
  const FEE_FAMILY_RE = [
    ['electricity', /pr[ąa]d|pr[ąa]dem|energia|electric|electricity/i],
    ['gas',         /\bgaz\b|\bgas\b|gazowy|gazowa/i],
    ['internet_tv', /internet|wi[\s-]?fi|wifi|telewizja|\btv\b|kablow|\bnet\b/i],
    ['parking',     /parking|gara[żz]|miejsce\s+parkingow|car\s+park|stand/i],
    ['utilities',   /media|rachunki|utilities|op[łl]ata|op[łl]aty|woda|water|heating|ogrzew|ciep[łl]|garbage|segreg|[śs]mieci/i],
    ['admin',       /admin|housing|community|building\s+fee|czynsz|sp[oó][łl]dzielni|wsp[oó][łl]lnota/i]
  ];
  function familyOf(label = '') {
    const s = String(label).toLowerCase();
    for (const [fam, re] of FEE_FAMILY_RE) if (re.test(s)) return fam;
    return 'other:' + s.slice(0, 20); // stable bucket for unknown labels
  }
  const seenExtras = new Map(); // family+amount -> kept item
  extras = extras.filter(e => {
    const fam = familyOf(e.name);
    // 'admin' family in extras is ALWAYS a duplicate of admin_fee bucket — drop.
    if (fam === 'admin') return false;
    const key = `${fam}:${e.amount}`;
    const prev = seenExtras.get(key);
    if (prev) {
      // Keep the non-estimated entry if available.
      if (!e.estimated && prev.estimated) {
        seenExtras.set(key, e);
        return true;
      }
      return false;
    }
    seenExtras.set(key, e);
    return true;
  });

  // Trust total_monthly from the model if it's plausible, otherwise recompute.
  const computed = rent
    + (admin_fee || 0)
    + (utilities || 0)
    + (parking || 0)
    + extras.reduce((a, b) => a + b.amount, 0);
  const modelTotal = pickInt(parsed.total_monthly);
  const total_monthly = (modelTotal != null && Math.abs(modelTotal - computed) <= Math.max(500, computed * 0.2))
    ? modelTotal
    : computed;

  const notes = parsed.notes ? String(parsed.notes).slice(0, 300) : null;
  return {
    rent,
    admin_fee,
    utilities,
    parking,
    extras,
    total_monthly,
    currency: CURRENCY,
    notes,
    computed_at: new Date().toISOString()
  };
}

// --- Regex fallback (deterministic, no AI cost) ---------------------------
// Used when the AI call fails or returns invalid JSON. Cheap and conservative:
// only extracts amounts that follow an unambiguous fee keyword in Polish.
// Anti-double-count: each fee keyword contributes to at most ONE bucket, and
// the rent itself never appears in extras.
const FEE_PATTERNS = [
  // bucket: admin_fee  (czynsz administracyjny / opłata administracyjna / czynsz dodatkowy)
  // The OLX scraper labels this fee as "Czynsz (dodatkowo)" in raw.params;
  // Otodom uses "Czynsz administracyjny". Both map to the same admin_fee bucket
  // so we never double-count it when a listing exposes both (the dedup set in
  // extractFromRegex collapses them to one entry by (bucket, amount)).
  //
  // Whitespace-only separator between keyword and number — no skipping
  // across sentence boundaries ("Media 200 zł. Administracyjne 500 zł" must
  // extract admin_fee=500, NOT 200).
  {
    bucket: 'admin_fee',
    re: /(?:czynsz\s+administracyj\w*|opłat\w*\s+administracyj\w*|administracyj\w*|czynsz\s*\(?\s*dodatkow[ao]\)?|dodatkow[ao]\s+czynsz)\s*[:=–-]?\s*(\d{2,5})\b/i
  },
  {
    bucket: 'admin_fee',
    re: /(\d{2,5})\s*(?:z[łl]|pln)?\s+(?:administracyj\w*|czynsz\s+administracyj\w*|opłat\w*\s+administracyj\w*|czynsz\s*\(?\s*dodatkow)/i
  },

  // bucket: utilities (media)
  { bucket: 'utilities', re: /media\s*[:=–-]?\s*(\d{2,5})\b/i },
  { bucket: 'utilities', re: /(\d{2,5})\s*(?:z[łl]|pln)?\s+media\b/i },

  // bucket: parking
  { bucket: 'parking', re: /(?:parking|miejsce\s+parkingowe|stanowisko)\s*[:=–-]?\s*(\d{2,5})\b/i },

  // bucket: extras — electricity
  { bucket: 'extras', key: 'Electricity', re: /(?:pr[ąa]d|elektryczn(?:ość|y))\s*[:=–-]?\s*(\d{2,5})\b/i },
  // bucket: extras — gas
  { bucket: 'extras', key: 'Gas', re: /gaz\s*[:=–-]?\s*(\d{2,5})\b/i },
  // bucket: extras — internet
  { bucket: 'extras', key: 'Internet', re: /internet\s*[:=–-]?\s*(\d{2,5})\b/i }
];

function extractFromRegex(listing) {
  const text = [
    listing.description || '',
    (listing.params || []).map(p => `${p.name || p.label || ''}: ${p.value || ''}`).join('\n')
  ].join('\n');
  if (!text.trim()) return null;

  const result = {
    rent: listing.price,
    admin_fee: null,
    utilities: null,
    parking: null,
    extras: [],
    total_monthly: listing.price,
    currency: CURRENCY,
    notes: 'Estimated from regex over listing text (AI unavailable).',
    computed_at: new Date().toISOString()
  };

  const seen = new Set(); // dedupe by (bucket, amount) so the same fee mentioned
                          // twice doesn't double-count (mirrors the AI rule).

  for (const { bucket, key, re } of FEE_PATTERNS) {
    // Use matchAll to find all occurrences; we only take the first match per
    // pattern (the second occurrence of "administracyjne 500" is almost always
    // a repeat, not a second fee).
    const m = re.exec(text);
    if (!m) continue;
    const amount = parseInt(m[1], 10);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 2000) continue;
    // dedupe by (bucket, key, amount) — for the extras bucket the key is the
    // family name (Electricity / Gas / Internet), so two legitimate extras
    // with the same amount but different families are NOT collapsed. For the
    // admin_fee/utilities/parking buckets (where key is undefined) the dedupe
    // collapses repeat mentions of the same fee in description + params.
    const dedupKey = bucket === 'extras'
      ? `extras:${key || ''}:${amount}`
      : `${bucket}:${amount}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (bucket === 'extras') {
      // avoid duplicate extra names with the same amount
      if (result.extras.some(e => e.name === key && e.amount === amount)) continue;
      result.extras.push({ name: key, amount, estimated: false });
    } else if (result[bucket] == null) {
      result[bucket] = amount;
    }
    // If the same bucket is already populated (e.g. admin_fee already set),
    // ignore subsequent matches — same anti-double-count rule as the AI.
  }

  // Recompute total
  result.total_monthly = result.rent
    + (result.admin_fee || 0)
    + (result.utilities || 0)
    + (result.parking || 0)
    + result.extras.reduce((a, b) => a + b.amount, 0);

  // If we found nothing beyond the rent, return null so the caller can decide
  // whether to store anything at all.
  if (result.total_monthly === result.rent && !result.extras.length) return null;
  return result;
}

/**
 * Graceful heuristic estimate — last-resort fallback when a listing has no
 * fee details at all (no description, no params) so the AI and the regex
 * extractor both come up empty. Estimates the utilities bundle from the
 * flat size (typical Polish rental: ~7 PLN/m²/month for water + heating +
 * garbage + electricity, clamped to a sane band) and marks it estimated so
 * the UI can render it as a guess, not a fact.
 *
 * Returns null when even the rent is missing (price <= 0, e.g. a watcher
 * stub awaiting enrichment) — there is nothing honest to add to.
 */
export function heuristicEstimate(listing) {
  const rent = pickInt(listing.price);
  if (rent == null || rent <= 0) return null;
  const area = typeof listing.area === 'number' && listing.area > 0 ? listing.area : null;
  const rooms = typeof listing.rooms === 'number' && listing.rooms > 0 ? listing.rooms : null;
  let utilities;
  if (area) utilities = Math.round(area * 7);
  else if (rooms) utilities = rooms * 90;
  else utilities = 250;
  utilities = Math.min(500, Math.max(150, utilities));
  return {
    rent,
    admin_fee: null,
    utilities: null,
    parking: null,
    extras: [{ name: 'Utilities (est.)', amount: utilities, estimated: true }],
    total_monthly: rent + utilities,
    currency: CURRENCY,
    notes: 'Heuristic estimate: the listing states no fee details, so utilities were guessed from the flat size.',
    computed_at: new Date().toISOString()
  };
}

/**
 * Single-listing AI estimate. Uses the shared seam (circuit-breaker + 15s
 * timeout). Falls back to extractFromRegex on any error so the rest of the run
 * doesn't break.
 */
export async function computeTotalEstimate(listing) {
  // No fee text at all — skip straight to the size-based heuristic so the
  // listing still gets a (marked-estimated) total instead of nothing.
  if (!listing.description && !(listing.params || []).length) return heuristicEstimate(listing);

  try {
    const content = await callAI({
      system: SYSTEM,
      user: buildPrompt(listing),
      opts: { maxTokens: 1024, temperature: 0.1 } // factual, not creative
    });
    const jsonStr = content.replace(/```(?:json)?/g, '').trim();
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    const parsed = JSON.parse(m[0]);
    return clampResult(parsed, listing.price);
  } catch (e) {
    console.warn(`[totalprice] AI failed (${e.code || e.message}), using regex fallback`);
    return extractFromRegex(listing) || heuristicEstimate(listing);
  }
}

// Compute + store for one listing id. Returns true when stored.
// CACHE: skip if total_estimate is already set on the listing row — this is
// the durable "already computed" signal across runs.
export async function computeAndStore(listingId) {
  const l = await one(
    `SELECT id, price, description, rooms, area, total_estimate, raw FROM listings WHERE id = $1`,
    [listingId]
  );
  if (!l) return false;
  if (l.total_estimate != null) return true; // already computed — skip AI
  const params = l.raw?.params || [];
  const result = await computeTotalEstimate({
    price: l.price,
    description: l.description,
    rooms: l.rooms,
    area: l.area,
    params
  });
  if (!result) return false;
  await query(
    `UPDATE listings SET total_estimate = $1, total_breakdown = $2 WHERE id = $3`,
    [result.total_monthly, JSON.stringify(result), listingId]
  );
  return true;
}

function parseBatchResponse(content, jobs) {
  let txt = content.replace(/```(?:json)?/g, '').trim();
  const start = txt.indexOf('[');
  const end = txt.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return new Array(jobs.length).fill(null);
  let arr;
  try {
    arr = JSON.parse(txt.slice(start, end + 1));
  } catch {
    return new Array(jobs.length).fill(null);
  }
  if (!Array.isArray(arr)) return new Array(jobs.length).fill(null);
  const byIdx = new Map();
  for (const item of arr) {
    const id = Number(item?.id);
    if (Number.isInteger(id)) byIdx.set(id, item);
  }
  return jobs.map(j => byIdx.get(j.idx) || null);
}

/**
 * Batched compute — issues ONE LLM call per BATCH_SIZE listings instead of N
 * calls. Skips listings that already have total_estimate set (cache hit).
 * Falls back to per-listing regex extractor when the batch AI call fails.
 *
 * @param {string[]} listingIds
 * @param {{limit?: number}} opts
 * @returns {Promise<{computed:number, cached:number, failed:number, aiCalls:number}>}
 */
export async function computeForListings(listingIds, { limit = 80 } = {}) {
  const ids = (listingIds || []).slice(0, limit);
  const result = { computed: 0, cached: 0, failed: 0, aiCalls: 0 };

  // Load all rows once; partition into cached vs todo
  const rows = await many(
    `SELECT id, price, description, rooms, area, total_estimate, raw FROM listings WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(rows.map(r => [r.id, r]));

  const todo = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) { result.failed++; continue; }
    if (l.total_estimate != null) { result.cached++; continue; }
    // No rent yet (watcher stub awaiting enrichment) — nothing honest to
    // total; the backlog pass picks it up once enrichment fills the price.
    if (!l.price || l.price <= 0) { result.failed++; continue; }
    todo.push(l);
  }

  if (!todo.length) {
    console.log(`[totalprice] ${result.cached} cached, ${result.failed} skipped, 0 AI calls`);
    return result;
  }

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    const batchJobs = chunk.map((l, k) => ({
      idx: k,
      listingId: l.id,
      listing: {
        price: l.price,
        description: l.description,
        rooms: l.rooms,
        area: l.area,
        params: l.raw?.params || []
      }
    }));

    result.aiCalls += 1;
    let parsed;
    try {
      const content = await callAI({
        system: BATCH_SYSTEM,
        user: buildBatchPrompt(batchJobs),
        opts: { maxTokens: 1536, temperature: 0.1 } // batched = 5 listings per call (lowered 2026-09-01: OpenRouter credit floor ~3.2k tokens was 402-ing 4096-token requests)
      });
      parsed = parseBatchResponse(content, batchJobs);
    } catch (e) {
      console.warn(`[totalprice] batch failed (${e.code || e.message}) — per-listing regex fallback`);
      parsed = new Array(batchJobs.length).fill(null);
    }

    for (let k = 0; k < batchJobs.length; k++) {
      const job = batchJobs[k];
      const item = parsed[k];
      let clamped = item ? clampResult(item, job.listing.price) : null;
      // Graceful degradation chain: regex over the listing text first, then
      // the size-based heuristic so EVERY listing with a rent ends up with
      // a total (marked estimated when guessed).
      if (!clamped) clamped = extractFromRegex(job.listing) || heuristicEstimate(job.listing);
      if (clamped) {
        await query(
          `UPDATE listings SET total_estimate = $1, total_breakdown = $2 WHERE id = $3`,
          [clamped.total_monthly, JSON.stringify(clamped), job.listingId]
        ).catch(() => {});
        result.computed++;
      } else {
        result.failed++;
      }
    }
  }

  console.log(`[totalprice] computed ${result.computed}/${ids.length} (cached ${result.cached}, failed ${result.failed}, ${result.aiCalls} AI calls)`);
  return result;
}
