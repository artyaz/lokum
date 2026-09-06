import { writable } from 'svelte/store';

// Hash-based router (#/feed, #/listing/:id, ...) with per-route scroll
// restoration. The whole app uses document scroll (window), so positions
// are saved/restored around route changes — leaving the feed for a listing
// and coming back returns you to the exact same scroll offset.

export const route = writable({ path: '/', params: {}, key: '/' });

const scrollPositions = new Map(); // route key -> scrollY
let current = null;                  // current route key
let suppressSave = false;            // skip saving scroll for the next leave

function parseHash() {
  let h = location.hash.slice(1) || '/feed';
  if (h === '/' || h === '') h = '/feed';
  const [path, qs] = h.split('?');
  const params = {};
  if (qs) {
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, params, key: path };
}

function restoreScroll(key) {
  // Wait for the new route to render, then apply the saved position.
  // Double rAF: first frame Svelte swaps the DOM, second frame heights
  // are settled (content-visibility keeps heights stable for the feed).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const y = scrollPositions.get(key) || 0;
      window.scrollTo(0, y);
    });
  });
}

function apply() {
  const next = parseHash();
  const prev = current;
  if (prev && prev !== next.key && !suppressSave) {
    scrollPositions.set(prev, window.scrollY);
  }
  suppressSave = false;
  current = next.key;
  route.set(next);
  restoreScroll(next.key);
}

// We manage scroll restoration ourselves (per route key).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('hashchange', apply);
apply();

export function navigate(path) {
  if (location.hash.slice(1) === path) return;
  // Capture the position at the moment of intent — by the time hashchange
  // fires, something may already have scrolled the page.
  if (current) scrollPositions.set(current, window.scrollY);
  suppressSave = true;
  location.hash = path;
}

export function back() {
  if (history.length > 1) history.back();
  else navigate('/feed');
}

// Drop a saved position (e.g. when feed filters change and the old
// scroll offset no longer applies).
export function clearScroll(key) {
  scrollPositions.delete(key);
}

export function saveScrollNow(key, y) {
  scrollPositions.set(key, y);
}
