// Photo perceptual hashing (pHash) for cross-provider duplicate detection.
//
// The same flat uploaded by the same agent to OLX + Otodom + Gratka carries
// the SAME JPEG photo bytes — but each portal hosts the file on its own CDN
// with a different URL and asset id. The URL-based imageKey() in dedupe.js
// therefore can't link the two listings; a CONTENT-based hash can.
//
// This module computes a 64-bit DCT-based perceptual hash of a listing's
// cover photo. The hash is stored on listings.photo_phash as 16-char hex.
// Two listings whose pHashes agree (exact match, or Hamming distance ≤ 5
// bits) are almost certainly the same photo regardless of CDN — closing the
// cross-provider blind spot documented in findings/B7-dedupe-audit.md.
//
// Image decoder strategy (no native deps REQUIRED, but uses them if present):
//   1. `sharp`           (optional dep, native, fastest) — resize 32×32 grayscale
//   2. `jpeg-js`         (pure JS, regular dep)         — decode + downsample in JS
//   3. neither available → computeAndStorePhotoPhash logs once and returns null
//                        for every URL. Dedupe gracefully degrades to the existing
//                        URL-key path (B7's imageKey() still runs as a secondary
//                        signal — see services/dedupe.js).
//
// Pure-JS DCT: ~30 lines, O(N^3) but N=32 → 32 768 multiplications, ~1ms.
// Reference: http://hackerfactor.com/papers/comparing_faces.jpg (Dr. Neal Krawetz)

// ---------------------------------------------------------------------------
// Image-decoder loaders (cached after first attempt — fail fast on prod boxes
// that lack the optional sharp native binding without retrying every call).
// ---------------------------------------------------------------------------

let _sharp = undefined;  // undefined = not yet probed; null = probed, missing; sharp = resolved
let _jpegJs = undefined; // same
let _warnedNoDecoder = false;

async function loadSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    _sharp = (await import('sharp')).default;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

async function loadJpegJs() {
  if (_jpegJs !== undefined) return _jpegJs;
  try {
    _jpegJs = (await import('jpeg-js')).default;
  } catch {
    _jpegJs = null;
  }
  return _jpegJs;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchPhotoBuffer(url, timeout = 12000) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.arrayBuffer();
}

// Downsample raw RGBA/RGB/Luma buffer to a targetN×targetN grayscale Uint8Array
// using simple box averaging. Channels can be 1 (gray), 3 (RGB), or 4 (RGBA).
function downsampleToGray(data, w, h, targetN) {
  const out = new Uint8Array(targetN * targetN);
  const channels = Math.max(1, Math.floor(data.length / (w * h)));
  for (let y = 0; y < targetN; y++) {
    const sy0 = Math.floor(y * h / targetN);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / targetN));
    for (let x = 0; x < targetN; x++) {
      const sx0 = Math.floor(x * w / targetN);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / targetN));
      let sum = 0, cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * w + sx) * channels;
          if (channels >= 3) {
            // BT.601 luma — same as sharp's greyscale() default
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          } else {
            sum += data[i];
          }
          cnt++;
        }
      }
      out[y * targetN + x] = cnt ? Math.round(sum / cnt) : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure-JS 2D DCT (Type-II). Output is Float64Array of size N*N (same layout
// as input). For pHash we only ever need the top-left 8×8 block of a 32×32
// DCT — but computing the full 32×32 once is cheaper than the slicing tricks.
// ---------------------------------------------------------------------------

let _dctMatrix32 = null; // memoized cosine matrix C[32][32]
function dctMatrix(N) {
  if (N === 32 && _dctMatrix32) return _dctMatrix32;
  const C = new Float64Array(N * N);
  const sqrt2_inv_N = Math.sqrt(2 / N);
  for (let k = 0; k < N; k++) {
    const alpha = k === 0 ? 1 / Math.sqrt(2) : 1;
    for (let n = 0; n < N; n++) {
      C[k * N + n] = alpha * sqrt2_inv_N * Math.cos(Math.PI * (2 * n + 1) * k / (2 * N));
    }
  }
  if (N === 32) _dctMatrix32 = C;
  return C;
}

// 2D DCT-II via separable 1D DCTs along rows then columns.
// Returns the FULL N×N DCT (we'll slice the top-left 8×8 outside).
function dct2D(pixels, N) {
  const C = dctMatrix(N);
  const tmp = new Float64Array(N * N); // rows transformed
  const out = new Float64Array(N * N); // both axes transformed
  // tmp[r][k] = sum_n C[k][n] * pixels[r][n]
  for (let r = 0; r < N; r++) {
    const rowBase = r * N;
    for (let k = 0; k < N; k++) {
      const cBase = k * N;
      let s = 0;
      for (let n = 0; n < N; n++) s += C[cBase + n] * pixels[rowBase + n];
      tmp[rowBase + k] = s;
    }
  }
  // out[k][c] = sum_n C[k][n] * tmp[n][c]    (transpose columns)
  for (let c = 0; c < N; c++) {
    for (let k = 0; k < N; k++) {
      const cBase = k * N;
      let s = 0;
      for (let n = 0; n < N; n++) s += C[cBase + n] * tmp[n * N + c];
      out[k * N + c] = s;
    }
  }
  return out;
}

// Build a 16-hex (64-bit) pHash from a 32×32 grayscale buffer.
// Standard pHash recipe:
//   - 2D DCT of the 32×32 image
//   - take the top-left 8×8 block (lowest frequencies; the DC term is at [0,0])
//   - compute the median of the 63 AC terms (skip DC because it carries the
//     overall image brightness, not structure)
//   - bit-set when block value > median
// Returns a 16-char lowercase hex string. Big-endian within the BigInt so
// the first hex char corresponds to block[0].
function dctPHashFromGray32(gray32) {
  const dct = dct2D(Float64Array.from(gray32), 32);
  const block = new Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      block[r * 8 + c] = dct[r * 32 + c];
    }
  }
  // median of the 63 AC coefficients (skip DC at index 0)
  const ac = block.slice(1).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)];
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (block[i] > median) hash |= (1n << BigInt(63 - i));
  }
  return hash.toString(16).padStart(16, '0');
}

// Simpler 8×8 average hash (aHash). Used when we cannot decode large enough
// pixels for DCT — or as a coarser fallback when sharp/jpeg-js are missing
// but the source happens to serve an 8×8 thumbnail we can read raw.
function avgHashFromGray8(gray8) {
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += gray8[i];
  const avg = sum / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (gray8[i] > avg) hash |= (1n << BigInt(63 - i));
  }
  return hash.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

/**
 * Compute a 16-char hex pHash for the photo at `url`.
 *
 * Strategy:
 *   1. sharp available → fetch bytes, resize to 32×32 grayscale, run DCT pHash.
 *   2. else jpeg-js available → fetch bytes, decode, downsample to 32×32,
 *      run DCT pHash.
 *   3. else → return null (logs once).
 *
 * @param {string} url  photo URL (must be http/https)
 * @returns {Promise<string|null>} 16-char lowercase hex pHash, or null on failure
 */
export async function computePhotoPhash(url) {
  if (!url || typeof url !== 'string') return null;

  let buffer;
  try {
    buffer = await fetchPhotoBuffer(url);
  } catch (e) {
    // Many CDNs return 403/404 for stale photo URLs; this is normal noise.
    // Don't log at info level — backfill over thousands of listings would
    // flood the journal.
    return null;
  }

  // 1. sharp path
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const { data } = await sharp(Buffer.from(buffer))
        .resize(32, 32, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return dctPHashFromGray32(data);
    } catch {
      // fall through to jpeg-js
    }
  }

  // 2. jpeg-js path (JPEG only — sharp handles webp/png/avif; without sharp
  //    we can only decode JPEGs here. That still covers the majority of OLX /
  //    Otodom photos since both CDNs serve JPEG by default.)
  const jpegJs = await loadJpegJs();
  if (jpegJs) {
    try {
      const decoded = jpegJs.decode(Buffer.from(buffer), { useTArray: true });
      if (decoded && decoded.width >= 8 && decoded.height >= 8) {
        // Downsample to 32×32 if we have enough pixels, else 8×8 (avg hash).
        const targetN = (decoded.width >= 32 && decoded.height >= 32) ? 32 : 8;
        const gray = downsampleToGray(decoded.data, decoded.width, decoded.height, targetN);
        return targetN === 32
          ? dctPHashFromGray32(gray)
          : avgHashFromGray8(gray);
      }
    } catch {
      // not a JPEG, or decode failed — fall through
    }
  }

  // 3. No decoder available — log once so we don't spam the journal.
  if (!_warnedNoDecoder) {
    _warnedNoDecoder = true;
    console.warn(
      '[phash] no image decoder available (sharp and jpeg-js both missing) — ' +
      'photo dedupe disabled. Install either dep to enable cross-provider phash dedupe.'
    );
  }
  return null;
}

/**
 * Hamming distance between two 16-hex-char pHashes (0..64).
 * Returns 0 for identical hashes, larger for more different photos.
 * A distance of 0 means the photos are perceptually identical;
 * ≤ 5 bits is the standard "same photo" threshold (re-encoded, watermarked,
 * lightly cropped JPEGs typically differ by 1–4 bits).
 *
 * @param {string} a  16-char hex
 * @param {string} b  16-char hex
 * @returns {number}  0..64, or 65 (max) if either input is malformed
 */
export function hammingDistanceHex(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 65;
  try {
    const ai = BigInt('0x' + a);
    const bi = BigInt('0x' + b);
    let x = ai ^ bi;
    let count = 0;
    while (x) {
      count += Number(x & 1n);
      x >>= 1n;
    }
    return count;
  } catch {
    return 65;
  }
}

// Exposed for tests / backfill-stats tooling.
export const _internal = {
  dct2D,
  dctMatrix,
  downsampleToGray,
  dctPHashFromGray32,
  avgHashFromGray8
};
