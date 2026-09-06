// Facebook scraper adapter.
//
// The Python package kevinzg/facebook-scraper handles the actual Facebook
// HTML/session work. This adapter selects directory groups from Postgres,
// streams JSON-lines events from the bridge, and normalizes rental posts into
// Lokum's listing shape.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { many, query } from '../../db.js';
import { BaseScraper } from './base.js';
import {
  activeFacebookCookieSession,
  getActiveFacebookCookies,
  markFacebookCookieSession,
} from '../../services/facebook-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_BRIDGE = path.join(BACKEND_ROOT, 'scripts', 'facebook_scraper_bridge.py');

const DISTRICTS = [
  'Bemowo', 'Białołęka', 'Bielany', 'Mokotów', 'Ochota', 'Praga-Północ',
  'Praga-Południe', 'Rembertów', 'Śródmieście', 'Targówek', 'Ursus',
  'Ursynów', 'Wawer', 'Wesoła', 'Włochy', 'Wola', 'Żoliborz'
];
const DISTRICTS_LOWER = DISTRICTS.map(district => district.toLowerCase());
const PRICE_RE = /(\d[\d\s\u00a0]{0,11}(?:[.,](?:\d{3}|\d{1,2}))?)\s*(?:zł|zl|pln)/gi;
const PRICE_CONTEXT_RE = /(?:cena|koszt|wynaj|rent|miesięcz|month)/;
const ROOMS_RE = /(\d+(?:[.,]\d+)?)\s*-?\s*(?:pokojowe|pokoje|pokój|pokoj|rooms?\b)/i;
const AREA_RE = /(\d+(?:[.,]\d+)?)\s*(?:m\s*[²2]|m\^2|metr[ówa]*)\b/i;
const FLOOR_RE = /(?:piętro|floor)\D{0,10}(\d{1,2})/i;
const RENTAL_RE = /(?:wynaj|na wynaj|do wynaj|rent(?:al)?\b|mieszkan|apartament|poko[jei]|room\b|flat\b|kawalerka|studio)/i;
const SALE_RE = /(?:sprzedaż|sprzedam|kup[ię]|for sale|sale\b)/i;

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function compact(value) {
  return String(value || '')
    .replace(/[\u00a0 \t]+/g, ' ')
    .trim();
}

function firstLine(value) {
  const line = compact(value)
    .split(/\n+/)
    .map(compact)
    .find(line => line.length > 2);
  return line ? line.slice(0, 110) : '';
}

function parsePolishNumber(value) {
  let text = String(value).replace(/[\s\u00a0]/g, '');
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const lastSeparator = Math.max(lastComma, lastDot);

  if (lastSeparator >= 0) {
    const decimalPart = text.slice(lastSeparator + 1);
    const hasGroupedThousands = /^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?$/.test(text);
    // In Polish formatting 3,500 and 3.500 are commonly thousands, while a
    // one/two digit tail is normally a decimal (for area values).
    if (!hasGroupedThousands && decimalPart.length <= 2) {
      text = `${text.slice(0, lastSeparator)}.${decimalPart}`;
    } else {
      text = text.replace(/[.,]/g, '');
    }
  }

  const parsed = parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePrice(input) {
  const text = compact(input);
  // Allow digit-group spacing ("3 800"), but never let the character class
  // cross a comma/period followed by whitespace ("2, 3 800 zł").
  const matches = [...text.matchAll(new RegExp(PRICE_RE.source, PRICE_RE.flags))];
  if (!matches.length) return null;

  const contextual = matches.find(match => {
    const start = Math.max(0, match.index - 40);
    const prefix = text.slice(start, match.index).toLowerCase();
    return PRICE_CONTEXT_RE.test(prefix);
  });
  if (contextual) {
    const price = parsePolishNumber(contextual[1]);
    if (price >= 300 && price <= 100000) return Math.round(price);
  }

  for (const match of matches) {
    const price = parsePolishNumber(match[1]);
    if (price >= 300 && price <= 100000) return Math.round(price);
  }
  return null;
}

export function parseRooms(input) {
  const text = compact(input);
  if (/(?:kawalerka|studio)\b/i.test(text)) return 1;
  const match = text.match(ROOMS_RE);
  const rooms = match ? parsePolishNumber(match[1]) : null;
  if (!rooms) return null;
  return rooms <= 10 ? Math.round(rooms) : null;
}

export function parseArea(input) {
  const match = compact(input).match(AREA_RE);
  const area = match ? parsePolishNumber(match[1]) : null;
  if (!area) return null;
  return area >= 8 && area <= 500 ? Math.round(area * 10) / 10 : null;
}

export function parseFloor(input) {
  const match = compact(input).match(FLOOR_RE);
  const floor = match ? parseInt(match[1], 10) : null;
  return floor >= 0 && floor <= 30 ? floor : null;
}

export function detectDistrict(input) {
  const text = compact(input).toLowerCase();
  const index = DISTRICTS_LOWER.findIndex(district => text.includes(district));
  return index >= 0 ? DISTRICTS[index] : null;
}

export function isLikelyRental(input) {
  const text = compact(input);
  if (!text) return false;
  const rental = RENTAL_RE.test(text);
  const sale = SALE_RE.test(text);
  return rental && (!sale || /(?:wynaj|rent)/i.test(text));
}

function canonicalFacebookUrl(url, groupId, postId) {
  const candidate = compact(url);
  const fallback = compact(postId)
    ? `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/posts/${encodeURIComponent(postId)}`
    : `https://www.facebook.com/groups/${encodeURIComponent(groupId)}`;
  if (!candidate) return fallback;
  return candidate
    .replace(/^https?:\/\/(?:m|mbasic)\.facebook\.com/, 'https://www.facebook.com')
    .replace(/^https?:\/\/facebook\.com/, 'https://www.facebook.com');
}

function fallbackPostId(post, groupId) {
  const stableBits = [
    post.post_id,
    post.post_url,
    post.w3_fb_url,
    post.text,
    post.time,
    post.header,
  ].filter(Boolean).join('|');
  return createHash('sha256').update(`${groupId}|${stableBits}`).digest('hex').slice(0, 24);
}

export function normalizeFacebookPost(post, group, city) {
  if (!post || !group?.group_id || !city?.id) return null;

  const text = compact(post.post_text || post.text || post.header || '');
  const description = [post.header, post.post_text || post.text]
    .map(compact)
    .filter(Boolean)
    .join('\n\n');
  const searchable = description || text;
  if (!isLikelyRental(searchable)) return null;

  const postId = compact(post.post_id) || fallbackPostId(post, group.group_id);
  const images = [...new Set(
    (Array.isArray(post.images) ? post.images : [])
      .concat(post.image ? [post.image] : [])
      .map(compact)
      .filter(url => /^https?:\/\//i.test(url))
  )].slice(0, 12);

  return {
    externalId: `fb:${group.group_id}:${postId}`,
    sourceId: 7,
    cityId: city.id,
    title: firstLine(text) || `Facebook post — ${group.name}`,
    description,
    price: parsePrice(searchable),
    currency: 'PLN',
    rooms: parseRooms(searchable),
    area: parseArea(searchable),
    floor: parseFloor(searchable),
    district: detectDistrict(searchable),
    street: null,
    address: null,
    lat: null,
    lng: null,
    url: canonicalFacebookUrl(post.post_url || post.w3_fb_url, group.group_id, postId),
    postedAt: post.time ? new Date(post.time) : null,
    images,
    conveniences: [],
    raw: {
      params: [],
      facebook: {
        groupId: group.group_id,
        groupName: group.name,
        groupCategory: group.category,
        groupCategories: group.categories || [],
        postId,
        username: post.username || null,
        likes: post.likes ?? null,
        comments: post.comments ?? null,
        shares: post.shares ?? null,
        link: post.link || null,
      },
    },
  };
}

export class FacebookScraper extends BaseScraper {
  supportsStreaming = true;

  constructor() {
    super({
      sourceId: 7,
      sourceSlug: 'facebook',
      baseUrl: 'https://www.facebook.com',
    });
  }

  async _selectedGroups() {
    const maxTier = intEnv('FACEBOOK_MAX_TIER', 1);
    const limit = intEnv('FACEBOOK_GROUP_LIMIT', 15);
    const params = [Math.max(1, Math.min(3, maxTier))];
    let sql = `
      SELECT group_id, name, url, category, categories, essential, tier,
             language, confidence, members
      FROM facebook_groups
      WHERE enabled = TRUE AND tier <= $1
      ORDER BY essential DESC, tier,
        CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        name
    `;
    if (limit > 0) {
      params.push(limit);
      sql += ` LIMIT $2`;
    }
    return many(sql, params);
  }

  async _recordGroup(groupId, patch) {
    const assignments = Object.keys(patch).map((key, index) => `${key} = $${index + 2}`);
    await query(
      `UPDATE facebook_groups SET ${assignments.join(', ')} WHERE group_id = $1`,
      [groupId, ...Object.values(patch)]
    );
  }

  async _runBridge(request, onEvent) {
    const python = process.env.FACEBOOK_SCRAPER_PYTHON ||
      path.join(BACKEND_ROOT, '.scraper-venv', 'bin', 'python');
    const script = process.env.FACEBOOK_BRIDGE_SCRIPT || DEFAULT_BRIDGE;
    const child = spawn(python, [script], {
      cwd: BACKEND_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let fatal = null;
    let callbackError = null;
    let processing = Promise.resolve();

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed || callbackError) return;

      // Pause the pipe while an event is handled. This gives natural
      // backpressure from Python instead of queueing parsed post objects.
      reader.pause();
      processing = processing.then(async () => {
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch (e) {
          console.warn('[facebook] ignored malformed bridge line:', e.message);
          return;
        }
        if (event.type === 'fatal') {
          fatal = new Error(event.error || 'Facebook bridge failed');
          return;
        }
        await onEvent(event);
      }).catch(e => {
        callbackError = e;
        child.kill('SIGTERM');
      }).finally(() => {
        reader.resume();
      });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (callbackError) reject(callbackError);
        else if (fatal) reject(fatal);
        else if (code === 0) resolve();
        else reject(new Error(`Facebook bridge exited ${signal ? `on ${signal}` : `with code ${code}`}: ${stderr.trim().slice(-500)}`));
      });
    });

    child.stdin.on('error', () => {}); // Python may exit before stdin is finished.
    child.stdin.end(JSON.stringify(request));
    try {
      await closed;
      // The process can close while the final asynchronous event is finishing.
      await processing;
      if (callbackError) throw callbackError;
    } catch (e) {
      reader.close();
      child.kill('SIGKILL');
      await processing.catch(() => {});
      if (callbackError) throw callbackError;
      if (e.code === 'ENOENT') {
        throw new Error(`Facebook Python interpreter not found (${python}). Run npm run setup:facebook`);
      }
      if (/ModuleNotFoundError/.test(e.message)) {
        throw new Error(`Facebook Python dependencies are missing. Run npm run setup:facebook (${e.message})`);
      }
      throw e;
    }
  }
  async fetchCity(city, options = {}) {
    if (city.slug !== 'warsaw') return [];
    const requireAuth = process.env.FACEBOOK_REQUIRE_AUTH !== '0';
    const cookieSession = requireAuth ? await getActiveFacebookCookies() : null;
    if (requireAuth && !cookieSession) {
      throw new Error('No active Facebook cookie session. Add cookies in Settings.');
    }
    const groups = await this._selectedGroups();
    if (!groups.length) return [];
    const groupById = new Map(groups.map(group => [group.group_id, group]));
    const listings = [];
    const streaming = typeof options.onListing === 'function';
    let normalizedCount = 0;
    const defaultGroupCap = Math.max(0, intEnv('FACEBOOK_PAGES', 3) * intEnv('FACEBOOK_POSTS_PER_PAGE', 25));

    const request = {
      groups,
      pages: intEnv('FACEBOOK_PAGES', 3),
      posts_per_page: intEnv('FACEBOOK_POSTS_PER_PAGE', 25),
      max_posts_per_group: intEnv('FACEBOOK_MAX_POSTS_PER_GROUP', defaultGroupCap),
      timeout_seconds: intEnv('FACEBOOK_REQUEST_TIMEOUT', 30),
      group_delay_ms: intEnv('FACEBOOK_GROUP_DELAY_MS', 750),
      soft_timeout_seconds: intEnv('FACEBOOK_BRIDGE_TIMEOUT', 900),
      dry_run: process.env.FACEBOOK_DRY_RUN === '1',
      base_url: process.env.FACEBOOK_BASE_URL || 'https://mbasic.facebook.com',
      require_auth: process.env.FACEBOOK_REQUIRE_AUTH !== '0',
      cookies: cookieSession?.cookies || null,
    };
    if (process.env.FACEBOOK_STOP_AT_SINCE === '1' && options.sinceTime) {
      request.latest_date = new Date(options.sinceTime).toISOString();
    }

    let runningGroup = null;
    try {
      await this._runBridge(request, async event => {
        if (event.type === 'group_start') {
          runningGroup = event.group_id;
          this._recordGroup(event.group_id, {
            last_scraped_at: new Date(),
            last_status: 'running',
            last_error: null,
          }).catch(() => {});
        } else if (event.type === 'post') {
          const group = groupById.get(event.group_id);
          const listing = normalizeFacebookPost(event.post, group, city);
          if (!listing) return;
          normalizedCount++;
          if (streaming) await options.onListing(listing);
          else listings.push(listing);
        } else if (event.type === 'group_done') {
          runningGroup = null;
          this._recordGroup(event.group_id, {
            last_status: 'success',
            last_error: null,
            post_count: event.count || 0,
          }).catch(() => {});
        } else if (event.type === 'group_error') {
          runningGroup = null;
          this._recordGroup(event.group_id, {
            last_status: 'error',
            last_error: event.error || 'unknown error',
          }).catch(() => {});
          console.warn(`[facebook] ${event.group_id}: ${event.error}`);
        }
      });
    } catch (e) {
      if (cookieSession && /(?:InvalidCookies|Cookies are not valid|Missing cookies|Facebook cookies)/i.test(e.message)) {
        markFacebookCookieSession(cookieSession.sessionId, 'invalid', e.message).catch(() => {});
      }
      if (runningGroup) {
        this._recordGroup(runningGroup, {
          last_status: 'error',
          last_error: e.message,
        }).catch(() => {});
      }
      throw e;
    }

    console.log(`[facebook] ${groups.length} directory group(s), ${normalizedCount} rental post(s) normalized`);
    return listings;
  }

  // Always-on watcher probe (Task I — H4 design).
  //
  // Facebook doesn't expose a per-post lookup API; the existing Python
  // bridge scrapes group feeds. For the watcher we run the SAME bridge
  // but with a reduced `pages=1 / posts_per_page=15` profile so each
  // tick costs ~1/3 the HTTP/session budget of a full cron fetch.
  //
  // Each post event is normalized via the existing `normalizeFacebookPost`
  // (which internally runs `isLikelyRental` so we DON'T enqueue non-rental
  // posts as listings) and we pluck just the lightweight fields
  // `[{ externalId, postedAt, url, cityId }]`.
  //
  // Facebook only covers warsaw (per the existing fetchCity guard) — the
  // bridge is group-feed-based and the groups in facebook_groups are all
  // warsaw rentals.
  //
  // H4-§5.6: keep Facebook on the Python bridge path. Do NOT try to replace
  // it with Playwright (high ban risk, ToS issues).
  async watchLatest(page, cities) {
    const city = cities.find(c => c.slug === 'warsaw');
    if (!city) return [];

    const requireAuth = process.env.FACEBOOK_REQUIRE_AUTH !== '0';
    const cookieSession = requireAuth ? await getActiveFacebookCookies() : null;
    if (requireAuth && !cookieSession) {
      // No active cookie session — don't throw (would trip the circuit
      // breaker 3 times and pause Facebook for 5 min, which is wrong;
      // missing cookies is an operator issue, not an anti-bot block).
      console.warn('[facebook] watcher: no active cookie session, skipping tick');
      return [];
    }
    const groups = await this._selectedGroups();
    if (!groups.length) return [];
    const groupById = new Map(groups.map(group => [group.group_id, group]));
    const out = [];

    const request = {
      groups,
      pages: intEnv('FACEBOOK_WATCH_PAGES', 1),
      posts_per_page: intEnv('FACEBOOK_WATCH_POSTS_PER_PAGE', 15),
      max_posts_per_group: intEnv('FACEBOOK_WATCH_POSTS_PER_GROUP', 15),
      timeout_seconds: intEnv('FACEBOOK_REQUEST_TIMEOUT', 30),
      group_delay_ms: intEnv('FACEBOOK_GROUP_DELAY_MS', 750),
      soft_timeout_seconds: intEnv('FACEBOOK_BRIDGE_TIMEOUT', 300),
      dry_run: process.env.FACEBOOK_DRY_RUN === '1',
      base_url: process.env.FACEBOOK_BASE_URL || 'https://mbasic.facebook.com',
      require_auth: process.env.FACEBOOK_REQUIRE_AUTH !== '0',
      cookies: cookieSession?.cookies || null,
    };

    let runningGroup = null;
    try {
      await this._runBridge(request, async event => {
        if (event.type === 'group_start') {
          runningGroup = event.group_id;
          this._recordGroup(event.group_id, {
            last_status: 'watching',
            last_error: null,
          }).catch(() => {});
        } else if (event.type === 'post') {
          const group = groupById.get(event.group_id);
          // Reuse the full normalizer so we get `isLikelyRental` filtering
          // and the same externalId / url canonicalization as the full cron.
          const listing = normalizeFacebookPost(event.post, group, city);
          if (!listing) return; // non-rental → skip
          out.push({
            externalId: listing.externalId,
            postedAt: listing.postedAt,
            url: listing.url,
            cityId: listing.cityId
          });
        } else if (event.type === 'group_done') {
          runningGroup = null;
          this._recordGroup(event.group_id, {
            last_status: 'watched',
            last_error: null,
            post_count: event.count || 0,
          }).catch(() => {});
        } else if (event.type === 'group_error') {
          runningGroup = null;
          this._recordGroup(event.group_id, {
            last_status: 'watch-error',
            last_error: event.error || 'unknown error',
          }).catch(() => {});
          console.warn(`[facebook] watcher ${event.group_id}: ${event.error}`);
        }
      });
    } catch (e) {
      // Cookie/session failures should not pause the watcher (operator issue,
      // not anti-bot) — but we can't easily distinguish here. Let the circuit
      // breaker in alwaysOn.js handle it; if it trips, the operator gets a
      // Telegram alert and can investigate.
      if (cookieSession && /(?:InvalidCookies|Cookies are not valid|Missing cookies|Facebook cookies)/i.test(e.message)) {
        markFacebookCookieSession(cookieSession.sessionId, 'invalid', e.message).catch(() => {});
      }
      if (runningGroup) {
        this._recordGroup(runningGroup, {
          last_status: 'watch-error',
          last_error: e.message,
        }).catch(() => {});
      }
      throw e;
    }
    return out;
  }
  // fetchOneListing is inherited from BaseScraper (returns null). Facebook's
  // Python bridge is group-feed-based and can't fetch a single post by ID;
  // the full cron's `fetchCity` is the only enrichment path.
}
