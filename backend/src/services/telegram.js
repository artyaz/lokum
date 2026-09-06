// Telegram notification service.
//
// Sends new-listing alerts through a Telegram bot:
//   photo (fetched by Telegram itself from the listing image URL)
//   caption with price, matched drawn regions, all-in estimate
//   inline button linking to the public listing page on our site
//
// Rule matching per user:
//   - price within [min_price, max_price] (either bound optional)
//   - if region_ids selected: listing's lat/lng must fall inside ANY selected region
//   - never sends the same listing twice to the same user (telegram_sent)

import { query, one, many } from '../db.js';
import { pointInPolygon } from '../routes/regions.js';
import { v4 as uuidv4 } from 'uuid';

const TG_API = 'https://api.telegram.org';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://flats.chmyl.com';

// ---------- bot token (shared, stored in app_settings) ----------
export async function getBotToken() {
  const r = await one(`SELECT value FROM app_settings WHERE key = 'telegram_bot_token'`);
  return r?.value || null;
}

export async function setBotToken(token) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('telegram_bot_token', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [token]
  );
}

// ---------- low-level Bot API ----------
async function tgCall(token, method, body, timeout = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error(data.description || `Telegram HTTP ${r.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

// Chats that recently messaged the bot (for chat-id detection in Settings)
export async function getRecentChats(token) {
  const updates = await tgCall(token, 'getUpdates', { limit: 100, timeout: 0 });
  const chats = new Map();
  for (const u of updates || []) {
    const msg = u.message || u.channel_post || u.edited_message;
    const chat = msg?.chat;
    if (!chat) continue;
    const key = String(chat.id);
    if (!chats.has(key)) {
      chats.set(key, {
        chat_id: chat.id,
        type: chat.type,
        title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null,
        username: chat.username || null
      });
    }
  }
  return [...chats.values()];
}

// ---------- public listing URL (share token) ----------
async function ensureShareToken(listingId, userId = null) {
  const existing = await one(`SELECT token FROM share_tokens WHERE listing_id = $1 LIMIT 1`, [listingId]);
  if (existing) return existing.token;
  const token = uuidv4().replace(/-/g, '').slice(0, 16);
  await query(
    `INSERT INTO share_tokens (token, listing_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [token, listingId, userId]
  );
  return token;
}

function fmtPrice(n) {
  if (n == null) return '';
  return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the caption HTML for a listing notification
function buildCaption(listing, matchedRegionNames, publicUrl) {
  const lines = [];
  const bits = [];
  if (listing.rooms) bits.push(`${listing.rooms} room${listing.rooms === 1 ? '' : 's'}`);
  if (listing.area) bits.push(`${listing.area} m²`);
  if (listing.floor) bits.push(`floor ${listing.floor}`);
  bits.push(listing.district || listing.city_name);

  lines.push(`<b>${esc(fmtPrice(listing.price))}/mo</b> · ${esc(bits.join(' · '))}`);
  if (listing.total_estimate && listing.total_estimate !== listing.price) {
    lines.push(`💡 ≈ ${esc(fmtPrice(listing.total_estimate))} all-in (incl. fees)`);
  }
  if (matchedRegionNames.length) {
    lines.push(`📍 ${esc(matchedRegionNames.join(', '))}`);
  }
  lines.push('');
  lines.push(`<a href="${esc(publicUrl)}">${esc(listing.title)}</a>`);
  const src = listing.source_name ? ` · via ${esc(listing.source_name)}` : '';
  lines.push(`<a href="${esc(publicUrl)}">Open on Lokum</a>${src}`);
  let caption = lines.join('\n');
  if (caption.length > 1000) caption = caption.slice(0, 997) + '…';
  return caption;
}

// Send one listing notification to one chat. Returns true on success.
export async function sendListingNotification({ token, chatId, listing, matchedRegionNames = [] }) {
  const shareToken = await ensureShareToken(listing.id, null);
  const publicUrl = `${PUBLIC_ORIGIN}/s/${shareToken}`;
  const caption = buildCaption(listing, matchedRegionNames, publicUrl);
  const keyboard = {
    inline_keyboard: [
      [{ text: '🏠 Open listing', url: publicUrl }],
      ...(listing.url ? [[{ text: `Source (${listing.source_name || 'link'})`, url: listing.url }]] : [])
    ]
  };

  const photo = listing.image_url || null;
  if (photo) {
    try {
      // Telegram fetches the image from this URL itself and embeds it
      await tgCall(token, 'sendPhoto', {
        chat_id: chatId,
        photo,
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return true;
    } catch (e) {
      // photo URL unreachable / wrong type → fall through to text message
      console.warn('[telegram] sendPhoto failed, falling back to message:', e.message);
    }
  }
  await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: keyboard
  });
  return true;
}

// Test notification — sends the freshest new listing if we have one,
// otherwise a plain hello message. Returns { ok, detail }.
export async function sendTestNotification(userId) {
  const settings = await one(`SELECT * FROM telegram_settings WHERE user_id = $1`, [userId]);
  const token = await getBotToken();
  if (!token) return { ok: false, detail: 'Bot token not set' };
  if (!settings?.chat_id) return { ok: false, detail: 'Chat ID not set' };

  const listing = await one(
    `SELECT l.*, s.name AS source_name,
            (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) AS image_url
     FROM listings l JOIN sources s ON s.id = l.source_id
     WHERE l.is_active = TRUE
     ORDER BY l.first_seen_at DESC LIMIT 1`
  );
  try {
    if (listing) {
      await sendListingNotification({
        token, chatId: settings.chat_id, listing,
        matchedRegionNames: ['— test notification —']
      });
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: settings.chat_id,
        text: '✅ Lokum test — Telegram notifications are working.'
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// Notify about a single listing (community import path) — same rules as runs
export async function notifyCommunityImport(listingId) {
  const token = await getBotToken();
  if (!token) return;
  const l = await one(
    `SELECT l.*, s.name AS source_name, c.name AS city_name,
            (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) AS image_url
     FROM listings l JOIN sources s ON s.id = l.source_id
     JOIN cities c ON c.id = l.city_id
     WHERE l.id = $1`,
    [listingId]
  );
  if (!l) return;

  const settings = await many(
    `SELECT ts.* FROM telegram_settings ts WHERE ts.enabled = TRUE AND ts.chat_id IS NOT NULL`
  );
  for (const s of settings) {
    if (s.min_price != null && l.price < s.min_price) continue;
    if (s.max_price != null && l.price > s.max_price) continue;

    let matchedNames = [];
    if (l.lat != null && l.lng != null) {
      const regions = await many(
        `SELECT id, name, polygon FROM regions WHERE user_id = $1 AND city_id = $2`,
        [s.user_id, l.city_id]
      );
      for (const r of regions) {
        if (s.region_ids?.length && !s.region_ids.includes(r.id)) continue;
        const poly = typeof r.polygon === 'string' ? JSON.parse(r.polygon) : r.polygon;
        if (pointInPolygon(l.lat, l.lng, poly)) matchedNames.push(r.name);
      }
    }
    if (s.region_ids?.length && !matchedNames.length) continue;

    try {
      await sendListingNotification({ token, chatId: s.chat_id, listing: l, matchedRegionNames: matchedNames });
      await query(
        `INSERT INTO telegram_sent (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [s.user_id, l.id]
      );
    } catch (e) {
      console.error('[telegram] import notify failed:', e.message);
    }
  }
}

// Send a plain-text admin alert to every enabled Telegram chat. Used by
// the always-on watcher (Task I — H4 §4.10) to broadcast circuit-breaker
// events ("watcher source X paused for 5 min after 3 consecutive errors").
// Reuses the existing bot token + telegram_settings wiring — no new auth.
//
// Best-effort: failures are logged but don't propagate (the caller —
// alwaysOn.js — must not throw on a Telegram outage). Rate-limited to one
// alert/chat/200ms to stay under the Bot API's 30-msg/sec global limit.
export async function sendAdminAlert(text, { label = 'admin' } = {}) {
  const token = await getBotToken();
  if (!token) return;
  const settings = await many(
    `SELECT ts.chat_id, u.name AS user_name
     FROM telegram_settings ts
     LEFT JOIN users u ON u.id = ts.user_id
     WHERE ts.enabled = TRUE AND ts.chat_id IS NOT NULL`
  );
  if (!settings.length) return;
  const message = `[${label}] ${text}`;
  for (const s of settings) {
    try {
      await tgCall(token, 'sendMessage', {
        chat_id: s.chat_id,
        text: message,
        disable_web_page_preview: true
      });
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`[telegram] admin alert to ${s.user_name || s.chat_id} failed:`, e.message);
    }
  }
}

// ---------- the pipeline: notify all users about new listings of a run ----------
export async function notifyNewListings(cronRunId) {
  const token = await getBotToken();
  if (!token) return;

  const settings = await many(
    `SELECT ts.*, u.name AS user_name
     FROM telegram_settings ts JOIN users u ON u.id = ts.user_id
     WHERE ts.enabled = TRUE AND ts.chat_id IS NOT NULL`
  );
  if (!settings.length) return;

  // listings that were NEW in this run and not yet notified per user
  const listings = await many(
    `SELECT l.id, l.title, l.price, l.rooms, l.area, l.floor, l.district, l.city_id,
            l.lat, l.lng, l.url, l.total_estimate,
            s.name AS source_name, c.name AS city_name,
            (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) AS image_url
     FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     JOIN sources s ON s.id = l.source_id
     JOIN cities c ON c.id = l.city_id
     WHERE crl.cron_run_id = $1 AND crl.was_new = TRUE`,
    [cronRunId]
  );
  if (!listings.length) return;

  // preload all regions of the relevant users
  const userIds = settings.map(s => s.user_id);
  const regionRows = await many(
    `SELECT id, user_id, city_id, name, polygon FROM regions WHERE user_id = ANY($1::uuid[])`,
    [userIds]
  );
  const regionsByUser = {};
  for (const r of regionRows) {
    (regionsByUser[r.user_id] ||= []).push({
      id: r.id, name: r.name, city_id: r.city_id,
      polygon: typeof r.polygon === 'string' ? JSON.parse(r.polygon) : r.polygon
    });
  }

  let sent = 0;
  const MAX_PER_USER_PER_RUN = 25; // never flood a chat, even on a big first run
  for (const s of settings) {
    let sentThisUser = 0;
    const allUserRegions = regionsByUser[s.user_id] || [];

    for (const l of listings) {
      if (sentThisUser >= MAX_PER_USER_PER_RUN) break;
      // price rule
      if (s.min_price != null && l.price < s.min_price) continue;
      if (s.max_price != null && l.price > s.max_price) continue;

      // region rule:
      //   region_ids selected → listing must be inside one of them
      //   none selected → no region constraint (whole city)
      let matchedNames = [];
      if (l.lat != null && l.lng != null) {
        for (const r of allUserRegions) {
          if (r.city_id !== l.city_id) continue;
          if (s.region_ids?.length && !s.region_ids.includes(r.id)) continue;
          if (pointInPolygon(l.lat, l.lng, r.polygon)) matchedNames.push(r.name);
        }
      }
      if (s.region_ids?.length && !matchedNames.length) continue;

      // already sent?
      const already = await one(
        `SELECT 1 AS x FROM telegram_sent WHERE user_id = $1 AND listing_id = $2`,
        [s.user_id, l.id]
      );
      if (already) continue;

      try {
        await sendListingNotification({ token, chatId: s.chat_id, listing: l, matchedRegionNames: matchedNames });
        await query(
          `INSERT INTO telegram_sent (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [s.user_id, l.id]
        );
        sent++;
        sentThisUser++;
        // be gentle with Bot API rate limits
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        console.error(`[telegram] send to ${s.user_name} failed for listing ${l.id}:`, e.message);
      }
    }
  }
  console.log(`[telegram] run ${cronRunId}: sent ${sent} notification(s)`);
}
