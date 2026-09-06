// Shared parser for sites exposing listings as schema.org Product →
// AggregateOffer → offers[] in JSON-LD (Gratka, Morizon — same platform).

export function extractProductOffers(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    if (data?.['@type'] === 'Product' && data.offers) {
      const offers = data.offers.offers || data.offers.itemListElement || [];
      if (Array.isArray(offers)) return offers;
    }
  }
  return [];
}

// Map one Offer to our normalized listing (partial — caller fills ids/city/source)
export function normalizeOffer(offer) {
  const io = offer.itemOffered || {};
  const price = offer.price != null ? Math.round(Number(offer.price)) : null;
  if (!price || !offer.url) return null;

  const addr = io.address || {};
  const street = addr.streetAddress || null;
  const district = addr.addressLocality || null;

  const images = [];
  if (offer.image) images.push(decodeImageThumb(offer.image));
  if (Array.isArray(io.photo)) {
    for (const p of io.photo) if (p?.url || p?.contentUrl) images.push(decodeImageThumb(p.url || p.contentUrl));
  }

  const params = [];
  if (io.numberOfRooms) params.push({ key: 'rooms', name: 'Liczba pokoi', value: String(io.numberOfRooms) });
  if (io.floorSize?.value) params.push({ key: 'm', name: 'Powierzchnia', value: `${io.floorSize.value} m²` });
  if (io.floorLevel) params.push({ key: 'floor', name: 'Piętro', value: String(io.floorLevel) });

  return {
    title: String(offer.name || '').trim(),
    description: io.description || '',
    price,
    rooms: io.numberOfRooms ? parseInt(io.numberOfRooms) : null,
    area: io.floorSize?.value ? Number(io.floorSize.value) : null,
    floor: io.floorLevel != null ? String(io.floorLevel) : null,
    district: district || '',
    street,
    address: [street, district].filter(Boolean).join(', '),
    url: offer.url,
    postedAt: offer.priceValidUntil ? null : null, // not provided by these sites
    images: [...new Set(images)],
    params
  };
}

// external id from offer url (last non-empty path segment)
export function externalIdFromUrl(url) {
  const parts = String(url).split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  // strip extension if any
  return last.replace(/\.html?$/i, '') || null;
}

// ---------- detail-page gallery (both sites share the same platform) ----------
// Gallery photos are CDN "thumb" URLs with a base64-encoded original URL:
//   https://thumbs.cdngr.pl/thumb/{base64}/{size_variant}/slug.jpg
// We decode the base64 to get the full-res original, dedupe by key,
// and filter out blog/ad images.
const SIZE_RANK = { xs: 1, s: 2, m: 3, l: 4, xl: 5 };

function decodeThumbUrl(base64Key) {
  try {
    const decoded = Buffer.from(base64Key, 'base64').toString('utf8');
    const urlM = decoded.match(/^(https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp))/i);
    if (urlM) return urlM[1];
    if (decoded.startsWith('http')) return decoded.replace(/[^\x20-\x7e].*$/, '');
  } catch {}
  return null;
}

// ---------- gratka/morizon __NUXT_DATA__ photo payload (primary path) ----------
//
// The gratka AND morizon detail pages both server-render only 3–4 unique
// thumb URLs in their visible carousel (a single cover <link rel=preload> +
// 3 gallery thumbs), even though the listing advertises 7–20 photos in its
// meta description. The other photos are NOT loaded via a separate AJAX
// endpoint (the gratka /api-gratka and gratka.api.gratka.it endpoints are
// 404s for direct listing id lookups) — they're embedded in the same SSR
// HTML, inside the `<script id="__NUXT_DATA__" type="application/json">`
// block, as a "Nuxt payload" array: a flat JSON array of primitives,
// dicts, and number-references between entries (a memory-compressed
// serialization Nuxt uses to avoid JSON object repetition).
//
// Gratka layout (verified on live gratka listing 48782533 — 17 photos
// advertised, 17 photos in __NUXT_DATA__):
//
//   data[0] = ["ShallowReactive", 1]
//   data[1] = {"data": 2, ...}                    ← root dict
//   data[2] = ["ShallowReactive", 3]
//   data[3] = {"property-details-/.../ob/<id>": 4, ...}
//   data[4] = ["ShallowReactive", 5]
//   data[5] = {"propertyData": 6, "similarProperties": 403, ...}   ← payload dict
//   data[6] = {"adKeywords": 7, ..., "photos": 122, ...}            ← propertyData dict
//   data[122] = [123, 127, 130, ..., 172]                          ← photos array (17 entries)
//   data[123] = {"id": 124, "name": 125, "alt": 126}                ← one photo dict
//   data[124] = "aHR0cHM6Ly9kLWdyLmNkbmdyLnBsL2thZHJ5L2..."         ← base64 photo URL
//
// Morizon layout (verified on live morizon listing mzn2047859771 — 8
// photos advertised, 8 photos in __NUXT_DATA__):
//
//   data[0] = ["ShallowReactive", 1]
//   data[1] = {"data": 2, ...}                    ← root dict
//   data[5] = {"propertyData": 6, "similarProperties": ..., ...}   ← payload dict (same shape as gratka)
//   data[6] = {"adKeywords": 7, "photos": 145, ..., etag/area/price/numberOfRooms/description}  ← propertyData dict
//   data[145] = [146, 150, 153, 156, 159, 162, 165, 168]            ← photos array (8 entries)
//   data[146] = {"id": 147, "name": 148, "alt": 149}              ← one photo dict
//   data[147] = "aHR0cHM6Ly9kLWdyLmNkbmdyLnBsL2thZHJ5L2..."         ← base64 photo URL
//
// Decoding that base64 yields the full-res original URL on the gratka CDN
// (shared by morizon — Grupa Morizon-Gratka): https://d-gr.cdngr.pl/kadry/...
//
// `extractNuxtPhotos` walks the chain above (with cycles broken via a
// visited-Set) and decodes each photo's base64 id. Falls back to the
// regex-based `extractPhotosFromHtml` if the Nuxt payload is missing (CF
// challenge page, browser-rendered shell).
//
// The function is platform-agnostic — same Nuxt payload layout is shared by
// gratka + morizon (both owned by Grupa Morizon-Gratka). Renamed from
// `extractGratkaNuxtPhotos` → `extractNuxtPhotos` in Task B4 to reflect
// this. The old name is kept as a backward-compat alias export for callers
// that still reference it (gratka.js, .photofill.mjs).
//
// NOTE: the gratka /photos URL pattern the user hypothesized
// (https://gratka.pl/.../ob/<id>/photos) returns a 404 ("Pod tym adresem
// nic nie ma..."). The /photos helper below is kept for backward compat
// but is unused — the canonical source is the same detail-page HTML.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function decodeNuxtPhotoB64(b64) {
  if (typeof b64 !== 'string' || b64.length < 20) return null;
  // Cheap sanity gate: must look like base64 (A–Z a–z 0–9 + / =). The
  // Nuxt payload also stores other base64-ish strings (growth-book keys,
  // recaptcha site keys, salesmanago sha) but none of those decode to a
  // http(s) URL with an image extension.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let decoded;
  try { decoded = Buffer.from(b64, 'base64').toString('utf8'); }
  catch { return null; }
  const urlM = decoded.match(/^(https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp))/i);
  if (urlM) return urlM[1];
  return null;
}

export function extractNuxtPhotos(html, { limit = 20 } = {}) {
  const s = String(html);
  const m = s.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); }
  catch { return []; }
  if (!Array.isArray(data) || data.length === 0) return [];

  // Resolve a possibly-tagged entry: ["ShallowReactive", N] → unwrap to
  // data[N]; any other shape returns as-is. The tag is Nuxt's way of
  // marking reactive wrappers around the actual data, and unwrapping is
  // idempotent (data[N] can itself be tagged).
  const seen = new Set();
  function resolveRef(idx) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= data.length) return undefined;
    if (seen.has(idx)) return undefined; // cycle guard
    seen.add(idx);
    const v = data[idx];
    if (Array.isArray(v) && v.length === 2 && v[0] === 'ShallowReactive' && typeof v[1] === 'number') {
      return resolveRef(v[1]);
    }
    return v;
  }

  // Find the payload dict: the entry that has BOTH `propertyData` (the
  // primary listing payload) AND `similarProperties` (similar-listings
  // payload). The top-level Nuxt payload dict at data[5] always has both;
  // a similarProperty's sub-payload doesn't. This guard prevents
  // accidentally grabbing a similarProperty's photos when gratka reorders
  // the data array.
  let propertyData = null;
  for (const entry of data) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.propertyData !== 'number') continue;
    // Loosen: similarProperties may be missing on edge-case listings
    // (developer build, draft). propertyData alone is enough — but
    // require propertyData to point to a dict that itself has `photos`
    // AND at least one of the unique propertyData keys (etag/area/price).
    const pd = resolveRef(entry.propertyData);
    if (!isPlainObject(pd)) continue;
    if (typeof pd.photos !== 'number') continue;
    if (!('etag' in pd || 'area' in pd || 'price' in pd || 'numberOfRooms' in pd || 'description' in pd)) continue;
    propertyData = pd;
    break;
  }
  if (!propertyData) return [];

  const photosArr = resolveRef(propertyData.photos);
  if (!Array.isArray(photosArr)) return [];

  const results = [];
  const seenUrls = new Set();
  for (const photoIdx of photosArr) {
    const photo = resolveRef(photoIdx);
    if (!isPlainObject(photo) || typeof photo.id !== 'number') continue;
    const b64 = resolveRef(photo.id);
    const url = decodeNuxtPhotoB64(b64);
    if (!url) continue;
    if (url.includes('/blog/') || url.includes('wp-content') || url.includes('gr-plogo')) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push(url);
    if (results.length >= limit) break;
  }
  return results;
}

// Core photo extraction (fallback path). Used when the __NUXT_DATA__
// payload is unavailable — e.g. on a Cloudflare challenge shell, a
// browser-rendered page that strips the JSON script tag. `zoneCut` is the
// literal string that marks the end of the photo zone on the page (e.g.
// "Podobne" on detail pages); pass null to scan the entire HTML. `limit`
// caps the result count — aligned with the persistListing cap of 20
// images/listing.
//
// On a typical gratka/morizon detail page this fallback returns only ~4
// photos (the cover + the visible gallery thumbs) because the platform
// lazy-loads the rest via the Nuxt payload rather than SSR-ing more `<img>`
// tags. The primary path (`extractNuxtPhotos`) is what catches the
// remaining 8–16 photos.
function extractPhotosFromHtml(html, { zoneCut = 'Podobne', limit = 20 } = {}) {
  const s = String(html);
  const zone = zoneCut && s.indexOf(zoneCut) > 0 ? s.slice(0, s.indexOf(zoneCut)) : s;
  const re = /https:\/\/(?:thumbs\.cdngr\.pl|img\d\.staticmorizon\.com\.pl)\/thumb\/([A-Za-z0-9+/=_-]+)(?:\/(\d+x\d+_[a-z]+))?[^"'\s]*/g;
  const order = [];
  const best = new Map();
  for (const m of zone.matchAll(re)) {
    const key = m[1];
    const size = m[2] ? (m[2].match(/_([a-z]+)$/) || [])[1] || 'm' : 'm';
    const rank = SIZE_RANK[size] || 3;
    if (!best.has(key)) {
      best.set(key, { url: m[0], rank });
      order.push(key);
    } else if (rank > best.get(key).rank) {
      best.set(key, { url: m[0], rank });
    }
  }
  // Decode base64 keys to original full-res URLs, filter out blog/ad/logo images
  const results = [];
  const seen = new Set();
  for (const k of order) {
    const original = decodeThumbUrl(k);
    if (!original) continue;
    if (original.includes('/blog/') || original.includes('wp-content') || original.includes('gr-plogo')) continue;
    if (seen.has(original)) continue;
    seen.add(original);
    results.push(original);
  }
  return results.slice(0, limit);
}

// Detail-page gallery — primary path is the __NUXT_DATA__ payload (returns
// up to 7–20 photos); falls back to the regex path (≤4 photos) when the
// Nuxt payload is absent. Cap aligned with persistListing's storage cap of
// 20 images/listing. Cuts the regex fallback at "Podobne" so a
// missing-Nuxt scenario doesn't accidentally pull similar-listing photos.
//
// Platform-agnostic: works for gratka + morizon (same Nuxt layout, same
// photo CDN at d-gr.cdngr.pl — both owned by Grupa Morizon-Gratka).
export function extractGalleryPhotos(html) {
  const nuxt = extractNuxtPhotos(html, { limit: 20 });
  if (nuxt.length) return nuxt;
  return extractPhotosFromHtml(html, { zoneCut: 'Podobne', limit: 20 });
}

// /photos page — kept for backward compat with .photofill.mjs and any
// external scripts that referenced this name. The gratka /photos URL
// pattern actually returns a 404 (verified live), so this helper no longer
// implies a separate fetch — it just runs the same Nuxt-first extraction
// on whatever HTML the caller hands it (typically the main listing HTML).
export function extractAllPhotos(html) {
  const nuxt = extractNuxtPhotos(html, { limit: 20 });
  if (nuxt.length) return nuxt;
  return extractPhotosFromHtml(html, { zoneCut: null, limit: 20 });
}

// Backward-compat alias — older callers (gratka.js, .photofill.mjs) import
// this name. Functionally identical to `extractNuxtPhotos` (same Nuxt
// payload layout is shared by gratka + morizon). New callers should use
// `extractNuxtPhotos` — the gratka-specific name is kept only to avoid a
// breaking rename across files outside this B4 scope.
export const extractGratkaNuxtPhotos = extractNuxtPhotos;

// Build the gratka /photos URL for a listing. Idempotent. Kept for
// backward compatibility with callers that referenced it; the gratka
// /photos page actually 404s in production (verified 2026-08-29), so
// this helper is unused by the gratka scraper — the canonical photo
// source is the main listing detail HTML's __NUXT_DATA__ payload.
//   https://gratka.pl/.../<id>      → https://gratka.pl/.../<id>/photos
//   https://gratka.pl/.../<id>/     → https://gratka.pl/.../<id>/photos
//   https://gratka.pl/.../<id>?x=1 → https://gratka.pl/.../<id>/photos?x=1
export function gratkaPhotosUrl(listingUrl) {
  if (!listingUrl) return '';
  try {
    const u = new URL(String(listingUrl));
    if (/\/photos\/?$/.test(u.pathname)) return u.href;
    u.pathname = u.pathname.replace(/\/+$/, '') + '/photos';
    return u.href;
  } catch {
    // Not a full URL — fall back to simple string concat.
    const raw = String(listingUrl);
    const qIdx = raw.search(/[?#]/);
    const base = (qIdx > 0 ? raw.slice(0, qIdx) : raw).replace(/\/+$/, '');
    if (!base) return '';
    if (/\/photos$/i.test(base)) return raw;
    const qs = qIdx > 0 ? raw.slice(qIdx) : '';
    return `${base}/photos${qs}`;
  }
}

// Decode a single thumbnail URL to its original full-res version
export function decodeImageThumb(url) {
  if (!url) return url;
  const m = String(url).match(/\/thumb\/([A-Za-z0-9+/=_-]+)/);
  if (m) {
    const original = decodeThumbUrl(m[1]);
    if (original && !original.includes('/blog/') && !original.includes('wp-content') && !original.includes('gr-plogo')) return original;
  }
  return url;
}

// Detail pages carry a longer description than the search JSON-LD
export function extractDetailDescription(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    if (d?.description && String(d.description).length > 80) {
      return String(d.description);
    }
  }
  return null;
}

// Extract coordinates from a detail page (JSON-LD geo, or embedded JS vars)
export function extractDetailCoords(html) {
  const s = String(html);
  // JSON-LD "geo": {"latitude": ..., "longitude": ...}
  const geoM = s.match(/"geo"\s*:\s*\{[^}]*"latitude"\s*:\s*([\d.]+)[^}]*"longitude"\s*:\s*([\d.]+)/);
  if (geoM) return { lat: parseFloat(geoM[1]), lng: parseFloat(geoM[2]) };
  // JS variables: lat = 52.123 / lng = 21.456 (various patterns)
  const latM = s.match(/(?:lat|latitude)["'\s]*[:=]\s*["']?([\d]{2}\.[\d]{3,})/i);
  const lngM = s.match(/(?:lng|lon|longitude)["'\s]*[:=]\s*["']?([\d]{2}\.[\d]{3,})/i);
  if (latM && lngM) return { lat: parseFloat(latM[1]), lng: parseFloat(lngM[1]) };
  // data-lat / data-lng attributes
  const dLat = s.match(/data-lat(?:itude)?=["']([\d.]+)["']/i);
  const dLng = s.match(/data-lng|data-lon(?:gitude)?=["']([\d.]+)["']/i);
  if (dLat && dLng) return { lat: parseFloat(dLat[1]), lng: parseFloat(dLng[1]) };
  // Plain "lat,lng" pair in Poland range (49-55 lat, 14-24 lng) — Gratka/Morizon style
  const pairM = s.match(/\b(5[0-4]\.\d{4,}|49\.\d{4,})\s*,\s*(1[4-9]\.\d{4,}|2[0-4]\.\d{4,})\b/);
  if (pairM) return { lat: parseFloat(pairM[1]), lng: parseFloat(pairM[2]) };
  return null;
}

// Extract street address from a detail page
export function extractDetailStreet(html) {
  const s = String(html);
  const m = s.match(/"streetAddress"\s*:\s*"([^"]{3,80})"/);
  if (m) return m[1];
  return null;
}

// Extract the listing's "added at" timestamp from a detail page.
// Gratka/Morizon detail pages don't expose `postedAt` in their JSON-LD Offer
// block (only `description`, `image`, `price`, `seller`). The Nuxt payload
// embedded further down the page, however, contains the original addedAt as
// an RFC-2822 GMT string right after the listing id:
//   …,"48782533","Sat, 29 Aug 2026 12:40:30 GMT",{…}
// plus a Polish-formatted fallback ("Data dodania","29.08.2026") which we use
// only if the GMT string is missing (it loses the time-of-day component).
// Without this, gratka/morizon listings get postedAt=null → runner falls back
// to "not seen in previous run" detection (works, but less precise than the
// postedAt >= sinceTime comparison the runner prefers — see runner.js:170-177).
export function extractDetailPostedAt(html) {
  const s = String(html);
  // Preferred: RFC-2822 GMT date — keeps time-of-day precision.
  const gmtM = s.match(
    /"(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+([\d:]+)\s+GMT"/
  );
  if (gmtM) {
    const d = new Date(gmtM[0].slice(1, -1)); // strip surrounding quotes
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: Polish "Data dodania","DD.MM.YYYY" — loses time-of-day, set to 00:00 UTC.
  const plM = s.match(/"Data dodania","(\d{1,2})\.(\d{1,2})\.(\d{4})"/);
  if (plM) {
    const iso = `${plM[3]}-${plM[2].padStart(2, '0')}-${plM[1].padStart(2, '0')}T00:00:00Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
