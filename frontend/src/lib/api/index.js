// API client — wraps fetch with cookies + JSON.
// Same-origin by default. For a split deploy (UI on Vercel, API on the VPS)
// set VITE_API_URL to the public API origin, e.g. VITE_API_URL=https://flats.chmyl.com
import { get } from 'svelte/store';
import { user } from '../store.js';

const BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

// Endpoints that must work without a session: the login bootstrap
// (me/login/logout/passkey login) and public share links. Everything else
// requires a logged-in user — request() throws before any fetch() leaves
// the browser, so authed-only traffic never hits the API origin unauthenticated.
const PUBLIC_ENDPOINTS = new Set([
  'GET /api/auth/me',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/passkey/login/options',
  'POST /api/auth/passkey/login/verify'
]);

export function isPublicEndpoint(method, url) {
  const m = String(method || 'GET').toUpperCase();
  const path = String(url || '').split('?')[0];
  if (PUBLIC_ENDPOINTS.has(m + ' ' + path)) return true;
  // Public share links (/api/public/:token) stay viewable without login.
  if (m === 'GET' && path.startsWith('/api/public/') && path.length > '/api/public/'.length) return true;
  return false;
}

export function isAuthenticated() {
  return get(user) != null;
}

async function request(method, url, { body, headers, raw } = {}) {
  if (!isPublicEndpoint(method, url) && !isAuthenticated()) {
    throw new ApiError('not_authenticated', 'Please log in to continue.');
  }
  const opts = {
    method,
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {})
    }
  };
  if (body != null) opts.body = JSON.stringify(body);
  let r;
  try {
    r = await fetch(BASE + url, opts);
  } catch (e) {
    throw new ApiError('network', 'Network error', e);
  }
  if (r.status === 204) return null;
  let json = null;
  try { json = await r.json(); } catch {}
  if (!r.ok) {
    const err = new ApiError(json?.error || ('http_' + r.status), json?.detail || r.statusText, json);
    throw err;
  }
  return raw ? r : json;
}

export class ApiError extends Error {
  constructor(code, message, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

export const api = {
  // auth (signup removed: registration is disabled, see routes/Signup.svelte)
  login: (body) => request('POST', '/api/auth/login', { body }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),

  // passkey
  passkeyRegOptions: () => request('POST', '/api/auth/passkey/register/options'),
  passkeyRegVerify: (body) => request('POST', '/api/auth/passkey/register/verify', { body }),
  passkeyLoginOptions: () => request('POST', '/api/auth/passkey/login/options'),
  passkeyLoginVerify: (body) => request('POST', '/api/auth/passkey/login/verify', { body }),

  // listings
  listings: (params) => {
    const q = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') q.set(k, String(v));
      }
    }
    return request('GET', '/api/listings?' + q.toString());
  },
  listing: (id) => request('GET', '/api/listings/' + id),
  cities: () => request('GET', '/api/listings/cities'),
  sources: () => request('GET', '/api/listings/sources'),
  runs: (limit = 12) => request('GET', '/api/listings/runs?limit=' + limit),
  publicListing: (token) => request('GET', '/api/public/' + token),
  translateListing: (id) => request('POST', '/api/listings/' + id + '/translate'),
  shareListing: (id) => request('POST', '/api/listings/' + id + '/share'),

  // saved
  saved: () => request('GET', '/api/saved'),
  save: (id) => request('POST', '/api/saved/' + id),
  unsave: (id) => request('DELETE', '/api/saved/' + id),

  // cron
  cronJobs: () => request('GET', '/api/cron-jobs'),
  createCronJob: (body) => request('POST', '/api/cron-jobs', { body }),
  updateCronJob: (id, body) => request('PATCH', '/api/cron-jobs/' + id, { body }),
  deleteCronJob: (id) => request('DELETE', '/api/cron-jobs/' + id),
  runJobNow: (id) => request('POST', '/api/cron-jobs/' + id + '/run-now'),
  testRun: (body) => request('POST', '/api/cron-jobs/test-run', { body }),

  cronRuns: (limit = 20) => request('GET', '/api/cron-runs?limit=' + limit),
  runNow: (body) => request('POST', '/api/cron-runs/run-now', { body }),

  // regions
  regions: (city) => request('GET', '/api/regions' + (city ? '?city=' + city : '')),
  createRegion: (body) => request('POST', '/api/regions', { body }),
  updateRegion: (id, body) => request('PATCH', '/api/regions/' + id, { body }),
  deleteRegion: (id) => request('DELETE', '/api/regions/' + id),

  // telegram
  telegram: () => request('GET', '/api/telegram'),
  saveTelegram: (body) => request('PUT', '/api/telegram', { body }),
  telegramChats: () => request('GET', '/api/telegram/chats'),
  telegramTest: () => request('POST', '/api/telegram/test'),

  // Facebook scraping session
  facebookSession: () => request('GET', '/api/facebook/session'),
  saveFacebookSession: (body) => request('PUT', '/api/facebook/session', { body }),
  deleteFacebookSession: () => request('DELETE', '/api/facebook/session'),

  // duplicates
  duplicates: (city) => request('GET', '/api/duplicates' + (city ? '?city=' + city : '')),
  runDedupe: () => request('POST', '/api/duplicates/run'),

  // community import
  importText: (body) => request('POST', '/api/import/text', { body }),

  // POIs (Task F) — listing chips + starring
  listingPois: (id, radius) =>
    request('GET', '/api/listings/' + id + '/pois' + (radius ? '?radius=' + radius : '')),
  starredPois: () => request('GET', '/api/pois/starred'),
  starPoi: (poi) => request('POST', '/api/pois/star', { body: poi }),
  unstarPoi: (poi) => request('DELETE', '/api/pois/star', { body: poi })
};
