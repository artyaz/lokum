// Shared helpers for listing routes.
//
// `formatPrice` is the legacy helper (kept here so listing-detail.js +
// listings.js don't need to duplicate it). `normalizeFees` is the new Task E
// helper that takes a listing row (with `price`, `total_estimate`, and
// `total_breakdown` JSONB) and returns a single canonical fee shape that the
// frontend can render — regardless of whether the stored breakdown is the
// NEW shape (post-Task-E totalprice.js) or the LEGACY shape (agent A7's
// batched {items:[{label, amount_pln, ...}]}).

export function formatPrice(n) {
  if (n == null) return '';
  return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
}

// Listing fee breakdown normalizer.
//
// Two storage shapes coexist in listings.total_breakdown JSONB:
//
//   NEW (post Task-E, totalprice.js v2):
//     {
//       rent: int, admin_fee: int|null, utilities: int|null, parking: int|null,
//       extras: [{name, amount, estimated?}],
//       total_monthly: int, currency: 'PLN', notes: str|null, computed_at: ISO8601
//     }
//
//   LEGACY (pre Task-E, totalprice.js v1 — agent A7's batched version):
//     {
//       items: [{label, amount_pln, estimated}],
//       notes: str|null, computed_at: ISO8601
//     }
//
// The frontend was rewritten in Task E to render the NEW shape (large total
// monthly + breakdown chips). To keep already-stored legacy rows renderable
// until the next compute cycle rewrites them, we normalize on READ to the NEW
// shape. This is cheap (single pass over the parsed object) and runs once per
// listing per request.
//
// Returns null when total_estimate is unset OR the breakdown is missing /
// unparseable. Callers fall back to listing.price in that case.

const ADMIN_LABEL_RE = /admin|housing|community|building fee|czynsz/i;
const UTILITIES_LABEL_RE = /util|media|woda|wod|ciepło|cieplo|garbage|śmieci|smieci|segreg/i;
const PARKING_LABEL_RE = /parking|garage|garaż|garaz|stanowisko|miejsce\s+parkingowe/i;

function pickInt(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function normalizeFees(listing) {
  if (!listing) return null;
  const price = pickInt(listing.price) || 0;
  const total = pickInt(listing.total_estimate);

  // The detail rows store the JSONB already-parsed by pg (it arrives as an
  // object). The listings.js decorate() path also calls here so both routes
  // share the same normalizer.
  let raw = listing.total_breakdown;
  if (raw == null) {
    // No breakdown — synthesize a minimal shape from total_estimate + price.
    if (total == null) return null;
    return {
      rent: price,
      admin_fee: null,
      utilities: null,
      parking: null,
      extras: [],
      total_monthly: total,
      currency: 'PLN',
      notes: null,
      computed_at: null
    };
  }
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw !== 'object') return null;

  // Fast path: the stored object already has the new shape.
  if ('total_monthly' in raw && ('admin_fee' in raw || 'rent' in raw)) {
    return {
      rent: pickInt(raw.rent) ?? price,
      admin_fee: pickInt(raw.admin_fee),
      utilities: pickInt(raw.utilities),
      parking: pickInt(raw.parking),
      extras: Array.isArray(raw.extras)
        ? raw.extras
            .map(e => ({
              name: String(e?.name || e?.label || 'Fee').slice(0, 80),
              amount: pickInt(e?.amount != null ? e.amount : e?.amount_pln) || 0,
              estimated: !!e?.estimated
            }))
            .filter(e => e.amount > 0 && e.amount <= 2000)
            .slice(0, 8)
        : [],
      total_monthly: pickInt(raw.total_monthly) ?? (total ?? price),
      currency: raw.currency || 'PLN',
      notes: raw.notes ? String(raw.notes).slice(0, 300) : null,
      computed_at: raw.computed_at || null
    };
  }

  // Legacy shape: { items: [{label, amount_pln, estimated}], notes, computed_at }
  const items = Array.isArray(raw.items) ? raw.items : [];
  let admin_fee = null;
  let utilities = null;
  let parking = null;
  const extras = [];

  for (const it of items) {
    const label = String(it?.label || it?.name || 'Fee');
    const amount = pickInt(it?.amount_pln ?? it?.amount);
    if (amount == null || amount <= 0 || amount > 2000) continue;
    if (ADMIN_LABEL_RE.test(label)) {
      if (admin_fee == null) admin_fee = amount;            // first match wins — no double count
    } else if (UTILITIES_LABEL_RE.test(label)) {
      if (utilities == null) utilities = amount;
    } else if (PARKING_LABEL_RE.test(label)) {
      if (parking == null) parking = amount;
    } else {
      if (!extras.some(e => e.name === label && e.amount === amount)) {
        extras.push({ name: label.slice(0, 80), amount, estimated: !!it?.estimated });
      }
    }
  }

  const computed = price
    + (admin_fee || 0)
    + (utilities || 0)
    + (parking || 0)
    + extras.reduce((a, b) => a + b.amount, 0);

  // Prefer the stored total_estimate (legacy column) when it's plausibly
  // close to our recompute — that's the source-of-truth INT column. Otherwise
  // use the recomputed value.
  const total_monthly = (total != null && Math.abs(total - computed) <= Math.max(500, computed * 0.3))
    ? total
    : computed;

  return {
    rent: price,
    admin_fee,
    utilities,
    parking,
    extras: extras.slice(0, 8),
    total_monthly,
    currency: 'PLN',
    notes: raw.notes ? String(raw.notes).slice(0, 300) : null,
    computed_at: raw.computed_at || null
  };
}
