// Translation service — translates Polish listing descriptions to English
// markdown and rewrites them into a cleaner structure. Also translates
// param labels+values (dictionary-based — no AI cost).
//
// *** AI CALLS GO THROUGH services/ai-client.js (the single seam). ***
// Agent E will swap that seam to OpenRouter (deepseek-v4-flash-latest).
// This file does NOT talk to the AI directly — it builds prompts and
// parses responses, and it uses the shared circuit breaker / hard
// timeout / translations cache that ai-client.js enforces.

import { query } from '../db.js';
import { callAI, getCachedTranslation, getCachedTranslationsBulk, setCachedTranslation } from './ai-client.js';

const SOURCE_LANG = 'pl';
const BATCH_SIZE = 5;        // listings per LLM call
const MAX_BATCH_INPUT_CHARS = 24000; // hard cap per prompt

const SYSTEM_PROMPT = `You are a professional real estate listing translator and copywriter.
You translate Polish rental listings into clear, informative English and restructure them into well-formatted markdown.

Rules:
1. Translate the description from Polish to English (if already English, just restructure).
2. Rewrite into a clear, informative structure using markdown:
   - Start with a brief engaging summary (1-2 sentences)
   - Use ## headings for sections like "About the apartment", "Location", "Costs", "Additional info"
   - Use bullet lists for features
   - Use **bold** for key facts
   - Do NOT invent information that isn't in the source
   - Do NOT include phone numbers, email addresses, or contact info
3. Keep it concise but complete — don't lose any information from the original.
4. PRESERVE all prices, numbers, areas, floor numbers VERBATIM — do not round, convert
   currencies, or reformat "2 500 zł" into "2500". Numbers must match the source exactly.
5. Preserve line breaks where they carry meaning (between paragraphs, list items).
   Do not collapse the description into a single run-on paragraph.
6. Output ONLY the markdown, no preamble.`;

const BATCH_SYSTEM_PROMPT = `You are a professional real estate listing translator and copywriter.
You translate Polish rental listings into clear, informative English markdown (same rules as the single-listing task).

For a BATCH of listings, you MUST respond with a STRICT JSON array — one object per input listing,
in the SAME ORDER as the input. Each object: {"id": <integer index, 0-based>, "markdown": "<english markdown translation>"}.

Rules per listing:
- Translate Polish -> English; restructure into clean markdown (## headings, bullet lists, **bold** key facts).
- Do NOT invent facts. Do NOT include phone numbers/emails/contact info.
- PRESERVE all prices, numbers, areas, floor numbers VERBATIM — never round, convert currencies,
  or reformat "2 500 zł" into "2500".
- PRESERVE line breaks where they carry meaning (between paragraphs / list items).
- The "markdown" value must be a single JSON string with \\n for line breaks.
- Output ONLY the JSON array, no preamble, no code fences.`;

function buildContext(l) {
  const params = (l.params || []).map(p => `${p.name}: ${p.value}`).join('\n');
  return [
    `Title: ${l.title}`,
    `Price: ${l.price} PLN`,
    `City: ${l.city}`,
    `District: ${l.district || 'N/A'}`,
    l.area ? `Area: ${l.area} m²` : '',
    l.rooms ? `Rooms: ${l.rooms}` : '',
    l.floor ? `Floor: ${l.floor}` : '',
    params ? `Parameters:\n${params}` : ''
  ].filter(Boolean).join('\n');
}

function buildSingleUserPrompt(l) {
  const context = buildContext(l);
  const description = l.description || '';
  return `Translate and restructure this Polish rental listing into clean English markdown:

---LISTING CONTEXT---
${context}
---END CONTEXT---

---DESCRIPTION---
${description}
---END DESCRIPTION---`;
}

function buildBatchUserPrompt(jobs) {
  // Each job: { idx, listingId, payload }
  // Truncate per-listing description to keep prompt under MAX_BATCH_INPUT_CHARS.
  const perListing = Math.max(800, Math.floor(MAX_BATCH_INPUT_CHARS / jobs.length));
  const lines = [`Translate the following ${jobs.length} listings. Respond with a JSON array of {id, markdown} in order.`];
  for (const j of jobs) {
    const ctx = buildContext(j.payload);
    const desc = (j.payload.description || '').slice(0, perListing - ctx.length - 200);
    lines.push(`\n=== LISTING id=${j.idx} ===`);
    lines.push(`---CONTEXT---\n${ctx}\n---END CONTEXT---`);
    lines.push(`---DESCRIPTION---\n${desc}\n---END DESCRIPTION---`);
  }
  return lines.join('\n');
}

function parseBatchResponse(content, jobs) {
  // Strip code fences, find the outermost JSON array
  let txt = content.replace(/```(?:json)?/g, '').trim();
  const start = txt.indexOf('[');
  const end = txt.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(txt.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  // Map by id (idx) — defensive: tolerate missing/out-of-order entries
  const byIdx = new Map();
  for (const item of arr) {
    const id = Number(item?.id);
    if (Number.isInteger(id) && typeof item?.markdown === 'string') {
      byIdx.set(id, item.markdown);
    }
  }
  return jobs.map(j => byIdx.get(j.idx) || null);
}

/**
 * Translate ONE listing description (used by the on-demand UI endpoint
 * POST /api/listings/:id/translate). Goes through callAI seam.
 *
 * @param {Object} listing - { title, description, price, city, district, area, rooms, floor, params }
 * @returns {Promise<string>} translated markdown
 */
export async function translateDescription(listing) {
  const description = listing.description || '';
  if (!description.trim()) return '';

  const content = await callAI({
    system: SYSTEM_PROMPT,
    user: buildSingleUserPrompt(listing),
    opts: {
      bypassCircuit: true, // on-demand UI call — don't respect a run-time circuit
      maxTokens: 2048,     // translations can be longer than the default 1024
      temperature: 0.2    // faithful, not creative
    }
  });
  return content || '';
}

/**
 * Batch-translate listings — issues ONE LLM call per BATCH_SIZE listings
 * instead of one call per listing. Also consults the `translations` cache
 * table so re-runs skip already-translated listings entirely.
 *
 * @param {Array<{listingId, payload}>} jobs
 * @returns {Promise<{translated:number, cached:number, failed:number, aiCalls:number}>}
 */
export async function translateBatch(jobs) {
  const result = { translated: 0, cached: 0, failed: 0, aiCalls: 0 };

  // 1) Cache check — skip listings we've already translated.
  //    (The listings.description_en column also acts as a soft cache: runner.js
  //    only enqueues a listing for translation if it's brand-new. The translations
  //    table is the durable cross-run cache for re-runs that pick up the same
  //    listing id through dedup/normalization paths.)
  //
  //    Task A7 (verification pass): use the BULK cache lookup — one SELECT with
  //    `WHERE listing_id = ANY(...)` instead of N sequential round-trips. For
  //    a busy 80-listing run this collapses ~80 SELECTs to 1.
  const todo = [];
  const cachedMap = await getCachedTranslationsBulk(
    jobs.map(j => j.listingId),
    SOURCE_LANG
  );
  for (const j of jobs) {
    const cached = cachedMap.get(j.listingId);
    if (cached) {
      await query(
        `UPDATE listings SET description_en = $2 WHERE id = $1 AND description_en IS NULL`,
        [j.listingId, cached]
      ).catch(() => {});
      result.cached++;
    } else {
      todo.push(j);
    }
  }

  if (!todo.length) return result;

  // 2) Chunk into batches and run sequentially. callAI consults the shared
  //    circuit breaker; if 3 consecutive AI calls fail the breaker opens and
  //    the remaining batches short-circuit to {ok:false, error:'circuit_open'}
  //    — we mark those listings as `failed` rather than retrying forever.
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    const localPromptJobs = chunk.map((c, k) => ({ idx: k, listingId: c.listingId, payload: c.payload }));
    const userPrompt = buildBatchUserPrompt(localPromptJobs);

    result.aiCalls += 1;
    let out;
    try {
      const content = await callAI({
        system: BATCH_SYSTEM_PROMPT,
        user: userPrompt,
        opts: { maxTokens: 4096, temperature: 0.2 } // batched = 5 listings per call
      });
      out = parseBatchResponse(content, localPromptJobs);
    } catch (e) {
      console.warn(`[translate] batch failed (${e.code || e.message})`);
      out = new Array(localPromptJobs.length).fill(null);
    }

    // Per-listing persist + cache write
    for (let k = 0; k < localPromptJobs.length; k++) {
      const md = out[k];
      const { listingId } = localPromptJobs[k];
      if (md) {
        await query(
          `UPDATE listings SET description_en = $2 WHERE id = $1 AND description_en IS NULL`,
          [listingId, md]
        ).catch(() => {});
        await setCachedTranslation(listingId, md, SOURCE_LANG);
        result.translated++;
      } else {
        result.failed++;
      }
    }
  }

  return result;
}

/**
 * Translate param labels and values from Polish to English.
 * Uses a dictionary for common OLX params, falls back to AI for unknown ones.
 * Pure dictionary path — NO AI call (zero cost).
 *
 * @param {Array} params - [{ key, name, value, normalizedValue }]
 * @returns {Array} [{ label, value }] in English
 */
const PARAM_DICT = {
  // labels
  'Zwierzęta': 'Pets',
  'Winda': 'Lift',
  'Parking': 'Parking',
  'Poziom': 'Floor',
  'Piętro': 'Floor',
  'Umeblowane': 'Furnished',
  'Rodzaj zabudowy': 'Building type',
  'Powierzchnia': 'Area',
  'Liczba pokoi': 'Rooms',
  'Czynsz (dodatkowo)': 'Additional rent',
  'Czynsz': 'Rent',
  'Firmowe': 'Business',
  'Typ ogłoszeniodawcy': 'Seller type',
  'Na czym polega współpraca': 'Cooperation type',
  'Czynsz najmu': 'Lease amount',
  'Kaucja': 'Deposit',
  'Powierzchnia dodatkowa': 'Additional area',
  'Rodzaj powierzchni dodatkowej': 'Additional area type',
  'Informacje dodatkowe': 'Additional info',
  'Media': 'Utilities',
  'Ziemia': 'Land',
  'Stan': 'Condition',
  'Stan wykończenia': 'Finish condition',
  'Rok wybudowania': 'Year built',
  'Materiał budynku': 'Building material',
  'Okna': 'Windows',
  'Ogrzewanie': 'Heating',
  'Dostępne od': 'Available from',
  'Czynsz administracyjny': 'Administrative fee',
  'Współwłaściciele': 'Co-owners',
  'Liczba poziomów': 'Number of floors',
  'Pokoje': 'Rooms',
  'Balkon / ogród / taras': 'Balcony / garden / terrace',
  'Przedłużenie umowy': 'Lease extension',
  'Numer referencyjny': 'Reference number',
  'Lokalizacja': 'Location',
  'Przyjazne': 'Friendly',
  'Bezpieczeństwo': 'Security',
  'Wjazd dla auta': 'Car entry',
  'Zgoda na zwierzęta': 'Pets allowed',
  'Wyposażenie': 'Equipment',
  'Informacje o dostępności': 'Availability info',
  'Charakterystyka': 'Characteristics'
};

const VALUE_DICT = {
  'Tak': 'Yes',
  'Nie': 'No',
  'Kawalerka': 'Studio',
  'one': '1 (studio)',
  'two': '2',
  'three': '3',
  'four': '4',
  'five': '5',
  'six': '6',
  'seven': '7',
  'eight': '8',
  'Brak': 'None',
  'Osobiste': 'Private',
  'Firmowe': 'Business',
  'Tak, z agencją': 'Yes, with agency',
  'bezpośrednio': 'direct',
  'Pośrednictwo': 'Agency',
  'Przy ulicy': 'On the street',
  'W garażu': 'In garage',
  'W hallu': 'In hall',
  'Przynależne': 'Assigned',
  'identyfikator': 'Permit identifier',
  'brak': 'none',
  'Blok': 'Block of flats',
  'Kamienica': 'Tenement',
  'Apartamentowiec': 'Apartment building',
  'Dom szeregowy': 'Terraced house',
  'Wolnostojący': 'Detached',
  'nowe': 'new',
  'po remoncie': 'after renovation',
  'do zamieszkania': 'ready to move in',
  'do remontu': 'needs renovation',
  'do wykończenia': 'to be finished',
  'plastikowe': 'PVC',
  'drewniane': 'wooden',
  'aluminiowe': 'aluminum',
  'miejskie': 'district',
  'gazowe': 'gas',
  'elektryczne': 'electric',
  'kotłownia': 'boiler room',
  'piec': 'stove',
  'pompa ciepła': 'heat pump',
  'kotłownia współna': 'shared boiler'
};

export function translateParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map(p => {
    const label = PARAM_DICT[p.name] || p.name || p.label || '';
    let value = p.value || '';
    if (VALUE_DICT[value]) {
      value = VALUE_DICT[value];
    } else if (p.normalizedValue && VALUE_DICT[p.normalizedValue]) {
      value = VALUE_DICT[p.normalizedValue];
    } else if (Array.isArray(p.normalizedValue)) {
      value = p.normalizedValue.map(v => VALUE_DICT[v] || v).join(', ');
    }
    return { label, value };
  });
}
